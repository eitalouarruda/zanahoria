import { create } from "zustand";
import { ipc, errorMessage } from "../ipc/commands";
import type { ConnectionConfig, ConnInfo, SavedConnection } from "../ipc/types";

export type ConnStatus = "disconnected" | "connecting" | "connected" | "error";

interface ConnectionsState {
  saved: SavedConnection[];
  statuses: Record<string, ConnStatus>;
  errors: Record<string, string>;
  infos: Record<string, ConnInfo>;
  load: () => Promise<void>;
  save: (config: ConnectionConfig) => Promise<void>;
  remove: (connId: string) => Promise<void>;
  connect: (connId: string) => Promise<ConnInfo>;
  disconnect: (connId: string) => Promise<void>;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  saved: [],
  statuses: {},
  errors: {},
  infos: {},

  load: async () => {
    set({ saved: await ipc.listSavedConnections() });
  },

  save: async (config) => {
    await ipc.saveConnection(config);
    await get().load();
  },

  remove: async (connId) => {
    await ipc.deleteConnection(connId);
    set((s) => {
      const { [connId]: _s, ...statuses } = s.statuses;
      const { [connId]: _i, ...infos } = s.infos;
      return { statuses, infos };
    });
    await get().load();
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
}));
