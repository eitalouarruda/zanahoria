import { create } from "zustand";
import { ipc } from "../ipc/commands";
import { useConnections } from "./connectionsStore";
import { locateError, type ErrorLocation } from "../lib/errorPosition";
import {
  buildPendingChanges,
  checkEditability,
  type InsertRow,
  type RowChange,
} from "../lib/editing";
import type {
  ColumnMeta,
  DbSchema,
  DbValue,
  Editability,
  PendingChange,
  QueryEvent,
  Row,
} from "../ipc/types";

export type { RowChange } from "../lib/editing";

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
  /** Dónde está el error en el editor, si el motor lo reporta. */
  errorAt: ErrorLocation | null;
  /** SQL que se ejecutó (puede ser solo la selección del editor). */
  executedSql: string | null;
  /** Offset de `executedSql` dentro del SQL del tab al ejecutar (null = desconocido). */
  executedFrom: number | null;
  /** Safe Mode: warnings pendientes de confirmación para este SQL. */
  warnings: string[];
  /** `executedSql` se puede re-ejecutar sin efectos (exportar todo). */
  readOnly: boolean;
  /** Cambios pendientes del grid, por índice de fila. */
  changes: Record<number, RowChange>;
  /** Filas nuevas (insert) como mapa índice de columna -> valor. */
  inserts: InsertRow[];
}

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  /**
   * Panel derecho del split: un sub-tab completo (SQL + resultado propios),
   * con id `${id}#split`. Todos los métodos que reciben `tabId` aceptan
   * también ese id, así el grid del split funciona igual que el principal.
   */
  split: QueryTab | null;
  result: ResultState;
}

export const SPLIT_SUFFIX = "#split";

/** Tab (o panel split, por su id) dentro del workspace. */
export function findTab(ws: Workspace | undefined, tabId: string): QueryTab | undefined {
  if (!ws) return undefined;
  for (const t of ws.tabs) {
    if (t.id === tabId) return t;
    if (t.split?.id === tabId) return t.split;
  }
  return undefined;
}

/** Todos los paneles (tabs y splits) del workspace. */
function allPanes(ws: Workspace): QueryTab[] {
  return ws.tabs.flatMap((t) => (t.split ? [t, t.split] : [t]));
}

/** Cambios del grid sin aplicar (filas editadas o borradas + filas nuevas). */
export function pendingOf(p: QueryTab | undefined): number {
  return p ? Object.keys(p.result.changes).length + p.result.inserts.length : 0;
}

/** Cambios sin aplicar de un tab, contando su split. */
export function tabPending(tab: QueryTab): number {
  return pendingOf(tab) + pendingOf(tab.split ?? undefined);
}

/** Cambios sin aplicar de todo el workspace. */
export function workspacePending(ws: Workspace | undefined): number {
  return ws ? allPanes(ws).reduce((n, p) => n + pendingOf(p), 0) : 0;
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

export type ActiveView = "home" | "favorites" | "history" | "settings" | string;

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
    errorAt: null,
    executedSql: null,
    executedFrom: null,
    warnings: [],
    readOnly: false,
    changes: {},
    inserts: [],
  };
}

/**
 * Offset de `sql` dentro de `doc`: el indicado si coincide; si no, la primera
 * aparición (null si no está, p.ej. el texto cambió desde entonces).
 */
function locateExecuted(doc: string, sql: string, hint: number): number | null {
  if (doc.slice(hint, hint + sql.length) === sql) return hint;
  const idx = doc.indexOf(sql);
  return idx === -1 ? null : idx;
}

let tabCounter = 0;
function newTab(title?: string, sql = ""): QueryTab {
  tabCounter += 1;
  return {
    id: `tab-${Date.now()}-${tabCounter}`,
    title: title ?? `Query ${tabCounter}`,
    sql,
    split: null,
    result: emptyResult(),
  };
}

interface WorkspaceState {
  workspaces: Record<string, Workspace>;
  order: string[];
  active: ActiveView;

  setActive: (view: ActiveView) => void;
  /**
   * Pide llevar el foco al editor de la query activa del workspace que quede
   * visible (p. ej. tras elegir una database con Ctrl+K).
   */
  editorFocusRequested: boolean;
  requestEditorFocus: () => void;
  consumeEditorFocus: () => void;
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
  /** Abre (copiando el SQL actual) o cierra el split del tab. */
  setTabSplit: (wsId: string, tabId: string, open: boolean) => void;

  runQuery: (
    wsId: string,
    tabId: string,
    confirmDangerous?: boolean,
    sqlOverride?: string,
    /** Offset de `sqlOverride` dentro del SQL del tab (ubica errores). */
    sqlFrom?: number,
  ) => Promise<void>;
  cancelQuery: (wsId: string, tabId: string) => Promise<void>;
  fetchMore: (wsId: string, tabId: string) => Promise<void>;
  applyQueryEvent: (event: QueryEvent) => void;

  editCell: (
    wsId: string,
    tabId: string,
    rowIndex: number,
    /** Índice de la columna en el resultado. */
    column: number,
    value: DbValue,
    oldValue: DbValue,
  ) => void;
  toggleDeleteRow: (wsId: string, tabId: string, rowIndex: number) => void;
  addInsertRow: (wsId: string, tabId: string) => void;
  editInsertCell: (
    wsId: string,
    tabId: string,
    insertIndex: number,
    /** Índice de la columna en el resultado. */
    column: number,
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
        tabs: ws.tabs.map((t) => {
          if (t.id === tabId) return fn(t);
          if (t.split?.id === tabId) return { ...t, split: fn(t.split) };
          return t;
        }),
      },
    },
  };
}

export const useWorkspaces = create<WorkspaceState>((set, get) => ({
  workspaces: {},
  order: [],
  active: "home",
  editorFocusRequested: false,

  requestEditorFocus: () => set({ editorFocusRequested: true }),
  consumeEditorFocus: () => set({ editorFocusRequested: false }),

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
    for (const t of allPanes(closing)) {
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
    for (const p of tab?.split ? [tab, tab.split] : tab ? [tab] : []) {
      if (p.result.queryId) void ipc.cancelQuery(p.result.queryId);
    }
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

  setTabSplit: (wsId, tabId, open) => {
    const tab = findTab(get().workspaces[wsId], tabId);
    if (!open && tab?.split?.result.queryId) void ipc.cancelQuery(tab.split.result.queryId);
    set((s) =>
      updateTab(s, wsId, tabId, (t) => ({
        ...t,
        split: open
          ? { ...newTab(`${t.title} (split)`, t.sql), id: `${t.id}${SPLIT_SUFFIX}` }
          : null,
      })),
    );
  },

  runQuery: async (wsId, tabId, confirmDangerous = false, sqlOverride, sqlFrom) => {
    const ws = get().workspaces[wsId];
    const tab = findTab(ws, tabId);
    if (!ws || !tab) return;
    // Si hay texto seleccionado en el editor se ejecuta solo eso;
    // si no, todo el contenido del tab.
    const raw = sqlOverride ?? tab.sql;
    const sql = raw.trim();
    if (!sql) return;
    const leading = raw.length - raw.trimStart().length;
    const executedFrom = locateExecuted(tab.sql, sql, (sqlFrom ?? 0) + leading);
    if (tab.result.queryId) void ipc.cancelQuery(tab.result.queryId);

    // El queryId se genera aquí y se registra ANTES de invocar, para que los
    // primeros events del backend ya encuentren el tab (sin carrera).
    const queryId = crypto.randomUUID();
    set((s) =>
      updateTab(s, wsId, tabId, (t) => ({
        ...t,
        result: { ...emptyResult(), queryId, running: true, executedSql: sql, executedFrom },
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
            // Si las columnas ya llegaron, comprobar que cuadran con el análisis.
            editability: checkEditability(res.editability, t.result.columns),
            warnings: res.warnings,
            readOnly: res.readOnly,
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
    const tab = findTab(get().workspaces[wsId], tabId);
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
    const tab = findTab(get().workspaces[wsId], tabId);
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
      const tab = allPanes(ws).find((t) => t.result.queryId === event.queryId);
      if (!tab) continue;
      set((st) =>
        updateTab(st, wsId, tab.id, (t) => {
          const r = { ...t.result };
          if (event.type === "error") {
            r.error = event.message;
            r.errorAt =
              event.position && r.executedSql
                ? locateError(t.sql, r.executedSql, r.executedFrom, event.position)
                : null;
            r.running = false;
          } else if (event.event.kind === "columns") {
            r.columns = event.event.columns;
            r.editability = checkEditability(r.editability, r.columns);
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
    const tab = findTab(get().workspaces[wsId], tabId);
    if (!tab) return [];
    const { editability, rows, changes, inserts } = tab.result;
    return buildPendingChanges(editability, rows, changes, inserts);
  },
}));
