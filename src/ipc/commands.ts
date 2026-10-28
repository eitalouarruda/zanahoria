import { invoke } from "@tauri-apps/api/core";
import type { ExportFormat, ExportOptions } from "../lib/export";
import type {
  BackupOptions,
  RestoreOptions,
  RestorePlan,
  SniffResult,
  ToolStatus,
  ConnectionConfig,
  ConnInfo,
  ColumnMeta,
  DbSchema,
  Editability,
  FavoriteQuery,
  HistoryEntry,
  MutationPreview,
  MutationResult,
  PendingChange,
  PlatformCapabilities,
  Row,
  RunQueryResponse,
  SavedConnection,
} from "./types";

export const ipc = {
  listSavedConnections: () => invoke<SavedConnection[]>("list_saved_connections"),
  saveConnection: (config: ConnectionConfig) => invoke<void>("save_connection", { config }),
  deleteConnection: (connId: string) => invoke<void>("delete_connection", { connId }),
  testConnection: (config: ConnectionConfig) => invoke<void>("test_connection", { config }),
  connect: (connId: string, database?: string) =>
    invoke<ConnInfo>("connect", { connId, database }),
  disconnect: (connId: string) => invoke<void>("disconnect", { connId }),

  runQuery: (args: {
    queryId: string;
    connId: string;
    database: string;
    sql: string;
    confirmDangerous?: boolean;
  }) => invoke<RunQueryResponse>("run_query", args),
  fetchMore: (queryId: string) => invoke<void>("fetch_more", { queryId }),
  cancelQuery: (queryId: string) => invoke<void>("cancel_query", { queryId }),

  listDatabases: (connId: string) => invoke<string[]>("list_databases", { connId }),
  /** Crea la database y devuelve la lista actualizada. */
  createDatabase: (connId: string, name: string) =>
    invoke<string[]>("create_database", { connId, name }),
  getSchema: (connId: string, database: string) =>
    invoke<DbSchema>("get_schema", { connId, database }),
  refreshSchema: (connId: string, database: string) =>
    invoke<DbSchema>("refresh_schema", { connId, database }),

  previewMutations: (connId: string, editability: Editability, changes: PendingChange[]) =>
    invoke<MutationPreview>("preview_mutations", { connId, editability, changes }),
  applyMutations: (
    connId: string,
    database: string,
    editability: Editability,
    changes: PendingChange[],
  ) => invoke<MutationResult>("apply_mutations", { connId, database, editability, changes }),

  getHistory: (args: { connId?: string; search?: string; limit?: number }) =>
    invoke<HistoryEntry[]>("get_history", args),
  clearHistory: (connId?: string) => invoke<void>("clear_history", { connId }),
  listFavorites: () => invoke<FavoriteQuery[]>("list_favorites"),
  saveFavorite: (favorite: FavoriteQuery) =>
    invoke<FavoriteQuery>("save_favorite", { favorite }),
  deleteFavorite: (id: string) => invoke<void>("delete_favorite", { id }),

  sqliteBackup: (connId: string, dest: string) =>
    invoke<void>("sqlite_backup", { connId, dest }),
  detectBackupTools: () => invoke<ToolStatus[]>("detect_backup_tools"),
  setBackupToolPath: (name: string, path: string) =>
    invoke<void>("set_backup_tool_path", { name, path }),
  sniffDumpFile: (path: string) => invoke<SniffResult>("sniff_dump_file", { path }),
  startBackup: (connId: string, options: BackupOptions) =>
    invoke<[string, string]>("start_backup", { connId, options }),
  planRestore: (connId: string, options: RestoreOptions) =>
    invoke<RestorePlan>("plan_restore", { connId, options }),
  startRestore: (connId: string, options: RestoreOptions) =>
    invoke<[string, string]>("start_restore", { connId, options }),
  cancelJob: (jobId: string) => invoke<void>("cancel_job", { jobId }),

  saveTextFile: (path: string, content: string) =>
    invoke<void>("save_text_file", { path, content }),
  /** Re-ejecuta la query (solo lectura) y exporta todas sus filas. Cancelable con cancelQuery(exportId). */
  exportQuery: (args: {
    exportId: string;
    connId: string;
    database: string;
    sql: string;
    format: ExportFormat;
    path: string;
    options: ExportOptions;
  }) => invoke<{ rows: number }>("export_query", args),
  /** Exporta filas ya cargadas (resultado completo). */
  exportRows: (args: {
    path: string;
    format: ExportFormat;
    columns: ColumnMeta[];
    rows: Row[];
    options: ExportOptions;
  }) => invoke<{ rows: number }>("export_rows", args),
  kvGet: <T>(table: "settings" | "ui_state", key: string) =>
    invoke<T | null>("kv_get", { table, key }),
  kvSet: (table: "settings" | "ui_state", key: string, value: unknown) =>
    invoke<void>("kv_set", { table, key, value }),
  getPlatformCapabilities: () =>
    invoke<PlatformCapabilities>("get_platform_capabilities"),

  checkUpdate: () => invoke<{ version: string } | null>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as any).message);
  return String(e);
}
