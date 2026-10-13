import { create } from "zustand";
import { ipc } from "../ipc/commands";
import { useConnections } from "./connectionsStore";
import type {
  ColumnMeta,
  DbSchema,
  DbValue,
  Editability,
  PendingChange,
  QueryEvent,
  Row,
} from "../ipc/types";

export interface RowChange {
  kind: "update" | "delete";
  values: Record<string, DbValue>;
  oldValues: Record<string, DbValue>;
}

export interface ResultState {
  queryId: string | null;
  columns: ColumnMeta[];
  rows: Row[];
  editability: Editability | null;
  running: boolean;
  truncated: boolean;
  affected: number | null;
  totalRows: number;
  error: string | null;
  /** SQL que se ejecutó (puede ser solo la selección del editor). */
  executedSql: string | null;
  /** Safe Mode: warnings pendientes de confirmación para este SQL. */
  warnings: string[];
  /** Cambios pendientes del grid, por índice de fila. */
  changes: Record<number, RowChange>;
  /** Filas nuevas (insert) como mapa columna -> valor. */
  inserts: Record<string, DbValue>[];
}

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  /** SQL del panel derecho del split (copia independiente); null = sin split. */
  splitSql: string | null;
  result: ResultState;
}

/**
 * Una entrada del rail: una conexión abierta sobre una database concreta.
 * La misma conexión puede tener varios workspaces (uno por database, Ctrl+K);
 * el backend mantiene un pool por database.
 */
export interface Workspace {
  /** `${connId}::${database}` — clave en `workspaces` y en `order`. */
  id: string;
  connId: string;
  database: string;
  schema: DbSchema | null;
  schemaError: string | null;
  tabs: QueryTab[];
  activeTabId: string;
}

export function workspaceId(connId: string, database: string): string {
  return `${connId}::${database}`;
}

export type ActiveView = "home" | "favorites" | "history" | string;

function emptyResult(): ResultState {
  return {
    queryId: null,
    columns: [],
    rows: [],
    editability: null,
    running: false,
    truncated: false,
    affected: null,
    totalRows: 0,
    error: null,
    executedSql: null,
    warnings: [],
    changes: {},
    inserts: [],
  };
}

let tabCounter = 0;
function newTab(title?: string, sql = ""): QueryTab {
  tabCounter += 1;
  return {
    id: `tab-${Date.now()}-${tabCounter}`,
    title: title ?? `Query ${tabCounter}`,
    sql,
    splitSql: null,
    result: emptyResult(),
  };
}

interface WorkspaceState {
  workspaces: Record<string, Workspace>;
  order: string[];
  active: ActiveView;

  setActive: (view: ActiveView) => void;
  /**
   * Abre (o activa, si ya existe) el workspace de `connId` sobre `database`
   * y devuelve su id. Los demás métodos reciben ese id como `wsId`.
   */
  openWorkspace: (connId: string, database: string) => string;
  /** Cierra el workspace; desconecta si era el último de esa conexión. */
  closeWorkspace: (wsId: string) => void;
  loadSchema: (wsId: string, refresh?: boolean) => Promise<void>;

  addTab: (wsId: string, title?: string, sql?: string) => void;
  closeTab: (wsId: string, tabId: string) => void;
  setActiveTab: (wsId: string, tabId: string) => void;
  setTabSql: (wsId: string, tabId: string, sql: string) => void;
  /** Abre (copiando el SQL actual), actualiza o cierra (null) el split del tab. */
  setTabSplit: (wsId: string, tabId: string, sql: string | null) => void;

  runQuery: (
    wsId: string,
    tabId: string,
    confirmDangerous?: boolean,
    sqlOverride?: string,
  ) => Promise<void>;
  cancelQuery: (wsId: string, tabId: string) => Promise<void>;
  fetchMore: (wsId: string, tabId: string) => Promise<void>;
  applyQueryEvent: (event: QueryEvent) => void;

  editCell: (
    wsId: string,
    tabId: string,
    rowIndex: number,
    column: string,
    value: DbValue,
    oldValue: DbValue,
  ) => void;
  toggleDeleteRow: (wsId: string, tabId: string, rowIndex: number) => void;
  addInsertRow: (wsId: string, tabId: string) => void;
  editInsertCell: (
    wsId: string,
    tabId: string,
    insertIndex: number,
    column: string,
    value: DbValue,
  ) => void;
  removeInsertRow: (wsId: string, tabId: string, insertIndex: number) => void;
  discardChanges: (wsId: string, tabId: string) => void;
  pendingChanges: (wsId: string, tabId: string) => PendingChange[];
}

function updateTab(
  s: WorkspaceState,
  wsId: string,
  tabId: string,
  fn: (tab: QueryTab) => QueryTab,
): Partial<WorkspaceState> {
  const ws = s.workspaces[wsId];
  if (!ws) return {};
  return {
    workspaces: {
      ...s.workspaces,
      [wsId]: {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === tabId ? fn(t) : t)),
      },
    },
  };
}

export const useWorkspaces = create<WorkspaceState>((set, get) => ({
  workspaces: {},
  order: [],
  active: "home",

  setActive: (view) => set({ active: view }),

  openWorkspace: (connId, database) => {
    const id = workspaceId(connId, database);
    if (get().workspaces[id]) {
      set({ active: id });
      return id;
    }
    const tab = newTab();
    set((s) => ({
      workspaces: {
        ...s.workspaces,
        [id]: {
          id,
          connId,
          database,
          schema: null,
          schemaError: null,
          tabs: [tab],
          activeTabId: tab.id,
        },
      },
      order: [...s.order, id],
      active: id,
    }));
    void get().loadSchema(id);
    return id;
  },

  closeWorkspace: (wsId) => {
    const closing = get().workspaces[wsId];
    if (!closing) return;
    for (const t of closing.tabs) {
      if (t.result.queryId) void ipc.cancelQuery(t.result.queryId);
    }
    set((s) => {
      const { [wsId]: _, ...workspaces } = s.workspaces;
      const order = s.order.filter((id) => id !== wsId);
      return {
        workspaces,
        order,
        active: s.active === wsId ? (order[order.length - 1] ?? "home") : s.active,
      };
    });
    // Sus pools (uno por database) se cierran con el último workspace.
    const stillOpen = Object.values(get().workspaces).some((w) => w.connId === closing.connId);
    if (!stillOpen) void useConnections.getState().disconnect(closing.connId);
  },

  loadSchema: async (wsId, refresh = false) => {
    const ws = get().workspaces[wsId];
    if (!ws) return;
    const patch = (p: Partial<Workspace>) =>
      set((s) => {
        const cur = s.workspaces[wsId];
        if (!cur) return {};
        return { workspaces: { ...s.workspaces, [wsId]: { ...cur, ...p } } };
      });
    try {
      const schema = refresh
        ? await ipc.refreshSchema(ws.connId, ws.database)
        : await ipc.getSchema(ws.connId, ws.database);
      patch({ schema, schemaError: null });
    } catch (e) {
      patch({ schemaError: String(e) });
    }
  },

  addTab: (wsId, title, sql) => {
    set((s) => {
      const ws = s.workspaces[wsId];
      if (!ws) return {};
      const tab = newTab(title, sql ?? "");
      return {
        workspaces: {
          ...s.workspaces,
          [wsId]: { ...ws, tabs: [...ws.tabs, tab], activeTabId: tab.id },
        },
      };
    });
  },

  closeTab: (wsId, tabId) => {
    const ws = get().workspaces[wsId];
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (tab?.result.queryId) void ipc.cancelQuery(tab.result.queryId);
    set((s) => {
      const cur = s.workspaces[wsId];
      if (!cur) return {};
      const tabs = cur.tabs.filter((t) => t.id !== tabId);
      const activeTabId =
        cur.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? "") : cur.activeTabId;
      return {
        workspaces: { ...s.workspaces, [wsId]: { ...cur, tabs, activeTabId } },
      };
    });
  },

  setActiveTab: (wsId, tabId) => {
    set((s) => {
      const ws = s.workspaces[wsId];
      if (!ws) return {};
      return {
        workspaces: { ...s.workspaces, [wsId]: { ...ws, activeTabId: tabId } },
      };
    });
  },

  setTabSql: (wsId, tabId, sql) => {
    set((s) => updateTab(s, wsId, tabId, (t) => ({ ...t, sql })));
  },

  setTabSplit: (wsId, tabId, splitSql) => {
    set((s) => updateTab(s, wsId, tabId, (t) => ({ ...t, splitSql })));
  },

  runQuery: async (wsId, tabId, confirmDangerous = false, sqlOverride) => {
    const ws = get().workspaces[wsId];
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (!ws || !tab) return;
    // Si hay texto seleccionado en el editor se ejecuta solo eso;
    // si no, todo el contenido del tab.
    const sql = (sqlOverride ?? tab.sql).trim();
    if (!sql) return;
    if (tab.result.queryId) void ipc.cancelQuery(tab.result.queryId);

    // El queryId se genera aquí y se registra ANTES de invocar, para que los
    // primeros events del backend ya encuentren el tab (sin carrera).
    const queryId = crypto.randomUUID();
    set((s) =>
      updateTab(s, wsId, tabId, (t) => ({
        ...t,
        result: { ...emptyResult(), queryId, running: true, executedSql: sql },
      })),
    );
    try {
      const res = await ipc.runQuery({
        queryId,
        connId: ws.connId,
        database: ws.database,
        sql,
        confirmDangerous,
      });
      set((s) =>
        updateTab(s, wsId, tabId, (t) => ({
          ...t,
          result: {
            ...t.result,
            queryId: res.started ? queryId : null,
            editability: res.editability,
            warnings: res.warnings,
            // si el Done ya llegó mientras esperábamos el invoke, no revivir
            running: res.started ? t.result.running : false,
          },
        })),
      );
    } catch (e) {
      set((s) =>
        updateTab(s, wsId, tabId, (t) => ({
          ...t,
          result: { ...t.result, running: false, error: String(e) },
        })),
      );
    }
  },

  cancelQuery: async (wsId, tabId) => {
    const tab = get().workspaces[wsId]?.tabs.find((t) => t.id === tabId);
    if (tab?.result.queryId) {
      await ipc.cancelQuery(tab.result.queryId);
      set((s) =>
        updateTab(s, wsId, tabId, (t) => ({
          ...t,
          result: { ...t.result, running: false },
        })),
      );
    }
  },

  fetchMore: async (wsId, tabId) => {
    const tab = get().workspaces[wsId]?.tabs.find((t) => t.id === tabId);
    if (tab?.result.queryId && tab.result.truncated) {
      set((s) =>
        updateTab(s, wsId, tabId, (t) => ({
          ...t,
          result: { ...t.result, running: true, truncated: false },
        })),
      );
      await ipc.fetchMore(tab.result.queryId);
    }
  },

  applyQueryEvent: (event) => {
    const s = get();
    for (const wsId of s.order) {
      const ws = s.workspaces[wsId];
      const tab = ws.tabs.find((t) => t.result.queryId === event.queryId);
      if (!tab) continue;
      set((st) =>
        updateTab(st, wsId, tab.id, (t) => {
          const r = { ...t.result };
          if (event.type === "error") {
            r.error = event.message;
            r.running = false;
          } else if (event.event.kind === "columns") {
            r.columns = event.event.columns;
          } else if (event.event.kind === "rows") {
            r.rows = [...r.rows, ...event.event.rows];
          } else if (event.event.kind === "done") {
            r.running = false;
            r.truncated = event.event.summary.truncated;
            r.affected = event.event.summary.affected;
            r.totalRows = event.event.summary.totalRows;
          }
          return { ...t, result: r };
        }),
      );
      return;
    }
  },

  editCell: (wsId, tabId, rowIndex, column, value, oldValue) => {
    set((s) =>
      updateTab(s, wsId, tabId, (t) => {
        const existing = t.result.changes[rowIndex];
        const change: RowChange = existing?.kind === "update"
          ? {
              ...existing,
              values: { ...existing.values, [column]: value },
              oldValues: { [column]: oldValue, ...existing.oldValues },
            }
          : {
              kind: "update",
              values: { [column]: value },
              oldValues: { [column]: oldValue },
            };
        return {
          ...t,
          result: {
            ...t.result,
            changes: { ...t.result.changes, [rowIndex]: change },
          },
        };
      }),
    );
  },

  toggleDeleteRow: (wsId, tabId, rowIndex) => {
    set((s) =>
      updateTab(s, wsId, tabId, (t) => {
        const changes = { ...t.result.changes };
        if (changes[rowIndex]?.kind === "delete") {
          delete changes[rowIndex];
        } else {
          changes[rowIndex] = { kind: "delete", values: {}, oldValues: {} };
        }
        return { ...t, result: { ...t.result, changes } };
      }),
    );
  },

  addInsertRow: (wsId, tabId) => {
    set((s) =>
      updateTab(s, wsId, tabId, (t) => ({
        ...t,
        result: { ...t.result, inserts: [...t.result.inserts, {}] },
      })),
    );
  },

  editInsertCell: (wsId, tabId, insertIndex, column, value) => {
    set((s) =>
      updateTab(s, wsId, tabId, (t) => ({
        ...t,
        result: {
          ...t.result,
          inserts: t.result.inserts.map((row, i) =>
            i === insertIndex ? { ...row, [column]: value } : row,
          ),
        },
      })),
    );
  },

  removeInsertRow: (wsId, tabId, insertIndex) => {
    set((s) =>
      updateTab(s, wsId, tabId, (t) => ({
        ...t,
        result: {
          ...t.result,
          inserts: t.result.inserts.filter((_, i) => i !== insertIndex),
        },
      })),
    );
  },

  discardChanges: (wsId, tabId) => {
    set((s) =>
      updateTab(s, wsId, tabId, (t) => ({
        ...t,
        result: { ...t.result, changes: {}, inserts: [] },
      })),
    );
  },

  /** Convierte el estado del grid a PendingChange[] para preview/apply. */
  pendingChanges: (wsId, tabId) => {
    const tab = get().workspaces[wsId]?.tabs.find((t) => t.id === tabId);
    if (!tab) return [];
    const { editability, columns, rows, changes, inserts } = tab.result;
    if (!editability?.editable) return [];

    const colIndex = new Map(columns.map((c, i) => [c.name, i]));
    const pkOf = (row: Row): Record<string, DbValue> => {
      const pk: Record<string, DbValue> = {};
      for (const pkCol of editability.pkColumns) {
        // buscar la columna del resultado cuyo source es la col PK
        const resultCol = Object.entries(editability.columnSources).find(
          ([, src]) => src === pkCol,
        )?.[0];
        const idx = resultCol != null ? colIndex.get(resultCol) : undefined;
        pk[pkCol] = idx != null ? row[idx] : { t: "null" };
      }
      return pk;
    };

    const out: PendingChange[] = [];
    for (const [rowIndexStr, change] of Object.entries(changes)) {
      const row = rows[Number(rowIndexStr)];
      if (!row) continue;
      if (change.kind === "delete") {
        out.push({ kind: "delete", pk: pkOf(row), values: {}, oldValues: {} });
      } else {
        // mapear nombres de columnas del resultado a columnas reales
        const values: Record<string, DbValue> = {};
        const oldValues: Record<string, DbValue> = {};
        for (const [col, value] of Object.entries(change.values)) {
          const src = editability.columnSources[col];
          if (src) {
            values[src] = value;
            oldValues[src] = change.oldValues[col];
          }
        }
        if (Object.keys(values).length > 0) {
          out.push({ kind: "update", pk: pkOf(row), values, oldValues });
        }
      }
    }
    for (const insert of inserts) {
      const values: Record<string, DbValue> = {};
      for (const [col, value] of Object.entries(insert)) {
        const src = editability.columnSources[col] ?? col;
        if (value.t !== "null") values[src] = value;
      }
      if (Object.keys(values).length > 0) {
        out.push({ kind: "insert", pk: {}, values, oldValues: {} });
      }
    }
    return out;
  },
}));
