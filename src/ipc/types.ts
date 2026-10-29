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
  | { queryId: string; type: "error"; message: string; position: ErrorPosition | null };

/** Posición de un error dentro del SQL enviado (ver db-core `ErrorPosition`). */
export type ErrorPosition =
  /** Offset 0-based en caracteres (Postgres). */
  | { kind: "offset"; offset: number }
  /** Línea 1-based relativa al statement `statement` (0-based) del script (MySQL). */
  | { kind: "line"; line: number; statement: number };

export interface Editability {
  /** Hay al menos una tabla editable. */
  editable: boolean;
  reason: string | null;
  /** Tablas reales del FROM/JOIN, en orden de aparición. */
  targets: EditTarget[];
  /** Una entrada por columna del resultado, en el mismo orden. */
  columns: ResultColumn[];
  /** Tabla sobre la que se pueden insertar/borrar filas (sólo sin JOIN). */
  rowTarget: number | null;
}

export interface EditTarget {
  namespace: string | null;
  table: string;
  alias: string | null;
  pkColumns: string[];
  /** Índice en el resultado de cada columna de `pkColumns`. */
  pkIndexes: number[];
  editable: boolean;
  reason: string | null;
}

export interface ResultColumn {
  /** Nombre esperado (null = expresión, no se comprueba). */
  name: string | null;
  /** Columna real de la que viene (null = read-only). */
  source: { target: number; column: string } | null;
}

export interface RunQueryResponse {
  started: boolean;
  editability: Editability | null;
  warnings: string[];
  /** La query se puede re-ejecutar sin efectos (exportar todas las filas). */
  readOnly: boolean;
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
  /** Índice en `Editability.targets`. */
  target: number;
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
  /** Versión del formato de archive de pg_dump ("1.16"). */
  archiveVersion: string | null;
  sourceEngine: "postgres" | "mysql" | "mariadb" | null;
  sourceVersion: string | null;
  dumpedBy: string | null;
  sourceDb: string | null;
  /** Tamaño en bytes (null para dumps en directorio). */
  size: number | null;
}

export interface BackupOptions {
  format: string;
  output: string;
  schemaOnly: boolean;
  dataOnly: boolean;
  tables: string[];
  /** Database a respaldar; ausente = la de la conexión. */
  database?: string;
}

export interface RestoreOptions {
  input: string;
  targetDb: string;
  clean: boolean;
  singleTransaction: boolean;
  /** Crear la database destino si no existe. */
  createDb: boolean;
  /** Seguir tras errores (el job igual se reporta como fallido). */
  continueOnError: boolean;
  /** Restaurar GRANT/REVOKE (por defecto no: los roles de origen no suelen existir). */
  keepPrivileges: boolean;
  /** Confirmación explícita para restaurar sobre una conexión en safe mode. */
  confirmSafeMode: boolean;
}

export interface PlanNote {
  code: string;
  params: Record<string, string>;
}

/** Análisis previo al restore: versiones, estrategia y correcciones. */
export interface RestorePlan {
  sniff: SniffResult;
  strategy: "direct" | "compat" | "script";
  tool: string | null;
  toolVersion: string | null;
  targetVersion: string | null;
  targetExists: boolean;
  targetTables: number | null;
  fixes: string[];
  warnings: PlanNote[];
  blocker: PlanNote | null;
}

/** Avance de un job: unidades hechas / total (0 = desconocido). */
export interface BackupProgress {
  jobId: string;
  done: number;
  total: number;
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

/**
 * Tipo de DbValue que corresponde al tipo de la columna (nombres de sqlx en
 * Postgres/MySQL/SQLite). `null` si no se reconoce: se trata como texto.
 */
export function dbTypeKind(dbType: string): DbValue["t"] | null {
  const ty = dbType.toUpperCase().replace(/\s+UNSIGNED$/, "").trim();
  if (ty.endsWith("[]")) return null;
  if (["BOOL", "BOOLEAN"].includes(ty)) return "bool";
  if (/^(INT[248]?|INTEGER|SMALLINT|TINYINT|MEDIUMINT|BIGINT|OID|YEAR)$/.test(ty)) return "int";
  if (/^(FLOAT[48]?|REAL|DOUBLE( PRECISION)?)$/.test(ty)) return "float";
  if (["NUMERIC", "DECIMAL", "MONEY"].includes(ty)) return "decimal";
  if (["JSON", "JSONB"].includes(ty)) return "json";
  if (ty === "DATE") return "date";
  if (["TIME", "TIMETZ"].includes(ty)) return "time";
  if (["TIMESTAMP", "TIMESTAMPTZ", "DATETIME"].includes(ty)) return "timestamp";
  if (ty === "UUID") return "uuid";
  return null;
}

/**
 * Convierte texto editado por el usuario de vuelta a DbValue, preservando el
 * tipo original. Si la celda era NULL, el tipo sale de `dbType` (columna).
 */
export function displayToDbValue(text: string, original: DbValue, dbType?: string): DbValue {
  if (text === "NULL" || text === "") return { t: "null" };
  const kind = original.t === "null" && dbType ? dbTypeKind(dbType) : original.t;
  switch (kind) {
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
