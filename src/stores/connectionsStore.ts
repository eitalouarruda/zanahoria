import { create } from "zustand";
import { ipc, errorMessage } from "../ipc/commands";
import type { ConnectionConfig, ConnInfo, SavedConnection } from "../ipc/types";

export type ConnStatus = "disconnected" | "connecting" | "connected" | "error";

// ui_state: grupos creados sin conexiones todavía y grupos colapsados.
const EMPTY_GROUPS_KEY = "connection_groups";
const COLLAPSED_GROUPS_KEY = "connection_groups_collapsed";

const readUi = async (key: string): Promise<string[]> => {
  try {
    return (await ipc.kvGet<string[]>("ui_state", key)) ?? [];
  } catch {
    return [];
  }
};

/** Normaliza el nombre de grupo: sin espacios sobrantes; vacío = sin grupo. */
export const normalizeGroup = (name: string | null | undefined): string | null =>
  name?.trim() || null;

/** Grupos existentes (con conexiones o creados vacíos), ordenados por nombre. */
export const groupNames = (saved: SavedConnection[], emptyGroups: string[]): string[] => {
  const names = new Set(emptyGroups);
  for (const c of saved) {
    const g = normalizeGroup(c.group);
    if (g) names.add(g);
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
};

interface ConnectionsState {
  saved: SavedConnection[];
  statuses: Record<string, ConnStatus>;
  errors: Record<string, string>;
  infos: Record<string, ConnInfo>;
  /** Grupos creados a mano que aún no tienen conexiones. */
  emptyGroups: string[];
  collapsedGroups: string[];
  load: () => Promise<void>;
  save: (config: ConnectionConfig) => Promise<void>;
  remove: (connId: string) => Promise<void>;
  connect: (connId: string) => Promise<ConnInfo>;
  disconnect: (connId: string) => Promise<void>;
  createGroup: (name: string) => void;
  renameGroup: (from: string, to: string) => Promise<void>;
  /** Borra el grupo; sus conexiones se conservan y quedan sin grupo. */
  deleteGroup: (name: string) => Promise<void>;
  toggleGroupCollapsed: (name: string) => void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  saved: [],
  statuses: {},
  errors: {},
  infos: {},
  emptyGroups: [],
  collapsedGroups: [],

  load: async () => {
    const [saved, emptyGroups, collapsedGroups] = await Promise.all([
      ipc.listSavedConnections(),
      readUi(EMPTY_GROUPS_KEY),
      readUi(COLLAPSED_GROUPS_KEY),
    ]);
    set({ saved, emptyGroups, collapsedGroups });
    pruneEmptyGroups();
  },

  save: async (config) => {
    await ipc.saveConnection({ ...config, group: normalizeGroup(config.group) });
    set({ saved: await ipc.listSavedConnections() });
    pruneEmptyGroups();
  },

  remove: async (connId) => {
    const group = normalizeGroup(get().saved.find((c) => c.id === connId)?.group);
    await ipc.deleteConnection(connId);
    set((s) => {
      const { [connId]: _s, ...statuses } = s.statuses;
      const { [connId]: _i, ...infos } = s.infos;
      return { statuses, infos };
    });
    set({ saved: await ipc.listSavedConnections() });
    // Al quitar la última conexión el grupo sigue existiendo, vacío.
    if (group && !get().saved.some((c) => normalizeGroup(c.group) === group)) {
      setEmptyGroups([...get().emptyGroups, group]);
    }
  },

  connect: async (connId) => {
    set((s) => ({ statuses: { ...s.statuses, [connId]: "connecting" } }));
    try {
      const info = await ipc.connect(connId);
      set((s) => ({
        statuses: { ...s.statuses, [connId]: "connected" },
        infos: { ...s.infos, [connId]: info },
        errors: { ...s.errors, [connId]: "" },
      }));
      return info;
    } catch (e) {
      set((s) => ({
        statuses: { ...s.statuses, [connId]: "error" },
        errors: { ...s.errors, [connId]: errorMessage(e) },
      }));
      throw e;
    }
  },

  disconnect: async (connId) => {
    await ipc.disconnect(connId);
    set((s) => ({ statuses: { ...s.statuses, [connId]: "disconnected" } }));
  },

  createGroup: (name) => {
    const group = normalizeGroup(name);
    if (!group || groupNames(get().saved, get().emptyGroups).includes(group)) return;
    setEmptyGroups([...get().emptyGroups, group]);
  },

  renameGroup: async (from, to) => {
    const target = normalizeGroup(to);
    if (!target || target === from) return;
    // Si `target` ya existe, los grupos se fusionan.
    await moveConnections(from, target);
    setEmptyGroups(get().emptyGroups.map((g) => (g === from ? target : g)));
    setCollapsed(get().collapsedGroups.map((g) => (g === from ? target : g)));
    pruneEmptyGroups();
  },

  deleteGroup: async (name) => {
    await moveConnections(name, null);
    setEmptyGroups(get().emptyGroups.filter((g) => g !== name));
    setCollapsed(get().collapsedGroups.filter((g) => g !== name));
  },

  toggleGroupCollapsed: (name) => {
    const collapsed = get().collapsedGroups;
    setCollapsed(
      collapsed.includes(name) ? collapsed.filter((g) => g !== name) : [...collapsed, name],
    );
  },
}));

function setEmptyGroups(groups: string[]) {
  const unique = [...new Set(groups)];
  useConnections.setState({ emptyGroups: unique });
  void ipc.kvSet("ui_state", EMPTY_GROUPS_KEY, unique);
}

function setCollapsed(groups: string[]) {
  const unique = [...new Set(groups)];
  useConnections.setState({ collapsedGroups: unique });
  void ipc.kvSet("ui_state", COLLAPSED_GROUPS_KEY, unique);
}

/** Un grupo "vacío" deja de serlo en cuanto alguna conexión lo usa. */
function pruneEmptyGroups() {
  const { saved, emptyGroups } = useConnections.getState();
  const used = new Set(saved.map((c) => normalizeGroup(c.group)));
  if (emptyGroups.some((g) => used.has(g))) {
    setEmptyGroups(emptyGroups.filter((g) => !used.has(g)));
  }
}

async function moveConnections(from: string, to: string | null) {
  const members = useConnections
    .getState()
    .saved.filter((c) => normalizeGroup(c.group) === from);
  // Sin password: el backend conserva el guardado en el SecretStore.
  for (const { hasPassword: _h, password: _p, ...config } of members) {
    await ipc.saveConnection({ ...config, group: to });
  }
  useConnections.setState({ saved: await ipc.listSavedConnections() });
  pruneEmptyGroups();
}
