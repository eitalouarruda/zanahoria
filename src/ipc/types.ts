// Tipos espejo de los DTOs de Rust (serde camelCase).

export type Engine = "postgres" | "mysql" | "mariadb" | "sqlite" | "redis";

export interface ConnectionConfig {
  id: string;
  name: string;
  engine: Engine;
  host: string;
  port: number | null;
  database: string;
  user: string;
  password?: string | null;
  useTls: boolean;
  safeMode: boolean;
  color?: string | null;
  /** Grupo en la lista de conexiones; null/ausente = sin grupo. */
  group?: string | null;
}

export interface SavedConnection extends ConnectionConfig {
  hasPassword: boolean;
}

export interface Capabilities {
  sql: boolean;
  transactions: boolean;
  multipleDatabases: boolean;
  backup: boolean;
}

export interface ConnInfo {
  connId: string;
  capabilities: Capabilities;
  databases: string[];
}

// Valores de celda: enum taggeado de Rust { t, v }.
export type DbValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: number }
  | { t: "float"; v: number }
  | { t: "decimal"; v: string }
  | { t: "text"; v: string }
  | { t: "bytes"; v: string }
  | { t: "json"; v: unknown }
  | { t: "date"; v: string }
  | { t: "time"; v: string }
  | { t: "timestamp"; v: string }
  | { t: "uuid"; v: string };

export type Row = DbValue[];

export interface ColumnMeta {
  name: string;
  dbType: string;
}

export interface ExecSummary {
  affected: number | null;
  truncated: boolean;
  totalRows: number;
}

export type QueryEvent =
  | { queryId: string; type: "exec"; event: { kind: "columns"; columns: ColumnMeta[] } }
  | { queryId: string; type: "exec"; event: { kind: "rows"; rows: Row[] } }
  | { queryId: string; type: "exec"; event: { kind: "done"; summary: ExecSummary } }
  | { queryId: string; type: "error"; message: string };

export interface Editability {
  editable: boolean;
  reason: string | null;
  namespace: string | null;
  table: string | null;
  pkColumns: string[];
  columnSources: Record<string, string>;
}

export interface RunQueryResponse {
  started: boolean;
  editability: Editability | null;
  warnings: string[];
}

export interface Column {
  name: string;
  dbType: string;
  nullable: boolean;
  isPk: boolean;
}

export interface Table {
  name: string;
  kind: "table" | "view";
  columns: Column[];
  primaryKey: string[];
}

export interface Namespace {
  name: string;
  tables: Table[];
}

export interface DbSchema {
  namespaces: Namespace[];
}

export type ChangeKind = "update" | "delete" | "insert";

export interface PendingChange {
  kind: ChangeKind;
  pk: Record<string, DbValue>;
  values: Record<string, DbValue>;
  oldValues: Record<string, DbValue>;
}

export interface MutationStatement {
  sql: string;
  params: DbValue[];
  previewSql: string;
  expectedRows: number | null;
}

export interface MutationPreview {
  statements: MutationStatement[];
  safeMode: boolean;
}

export interface MutationResult {
  affectedTotal: number;
  statementsRun: number;
}

export interface HistoryEntry {
  id: number;
  connId: string;
  database: string;
  sql: string;
  status: string;
  durationMs: number;
  executedAt: number;
}

export interface FavoriteQuery {
  id: string;
  name: string;
  sql: string;
  connId: string;
  database: string;
  tags: string[];
  createdAt: number;
}

export interface ToolStatus {
  name: string;
  path: string | null;
  version: string | null;
}

export interface SniffResult {
  kind: "pg_custom" | "pg_tar" | "pg_directory" | "plain_sql" | "unknown";
  compressed: boolean;
  restoreTool: string | null;
  note: string;
}

export interface BackupOptions {
  format: string;
  output: string;
  schemaOnly: boolean;
  dataOnly: boolean;
  tables: string[];
}

export interface RestoreOptions {
  input: string;
  targetDb: string;
  clean: boolean;
  singleTransaction: boolean;
}

export type BackupEvent =
  | { jobId: string; kind: "line"; text: string }
  | { jobId: string; kind: "done"; success: boolean; message: string };

export interface PlatformCapabilities {
  os: string;
  isMobile: boolean;
  backupSupported: boolean;
}

export function dbValueToDisplay(v: DbValue): string {
  switch (v.t) {
    case "null":
      return "NULL";
    case "json":
      return JSON.stringify(v.v);
    case "bytes":
      return `<binary ${v.v.length} b64 chars>`;
    default:
      return String(v.v);
  }
}

/** Convierte texto editado por el usuario de vuelta a DbValue, preservando el tipo original. */
export function displayToDbValue(text: string, original: DbValue): DbValue {
  if (text === "NULL" || text === "") return { t: "null" };
  switch (original.t) {
    case "bool":
      return { t: "bool", v: text.toLowerCase() === "true" || text === "1" };
    case "int": {
      const n = Number(text);
      return Number.isInteger(n) ? { t: "int", v: n } : { t: "text", v: text };
    }
    case "float": {
      const n = Number(text);
      return Number.isNaN(n) ? { t: "text", v: text } : { t: "float", v: n };
    }
    case "decimal":
      return { t: "decimal", v: text };
    case "json":
      try {
        return { t: "json", v: JSON.parse(text) };
      } catch {
        return { t: "text", v: text };
      }
    case "date":
      return { t: "date", v: text };
    case "time":
      return { t: "time", v: text };
    case "timestamp":
      return { t: "timestamp", v: text };
    case "uuid":
      return { t: "uuid", v: text };
    default:
      return { t: "text", v: text };
  }
}
