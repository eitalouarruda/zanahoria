import { save } from "@tauri-apps/plugin-dialog";
import { ipc } from "../ipc/commands";
import type { ColumnMeta, DbValue, Row } from "../ipc/types";
import { dbValueToDisplay } from "../ipc/types";

export type ExportFormat = "csv" | "json" | "sql";

/** Separador de CSV por defecto (el que espera Excel en locales con coma decimal). */
export const DEFAULT_CSV_SEPARATOR = ";";

export interface ExportOptions {
  /** Separador de campos del CSV. */
  csvSeparator?: string;
}

function csvEscape(value: string, separator: string): string {
  if (/["\n\r]/.test(value) || value.includes(separator)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function sqlLiteral(v: DbValue): string {
  switch (v.t) {
    case "null":
      return "NULL";
    case "bool":
      return v.v ? "TRUE" : "FALSE";
    case "int":
    case "float":
      return String(v.v);
    case "decimal":
      return v.v;
    case "json":
      return `'${JSON.stringify(v.v).replace(/'/g, "''")}'`;
    default:
      return `'${String(v.v).replace(/'/g, "''")}'`;
  }
}

function cellRaw(v: DbValue): unknown {
  switch (v.t) {
    case "null":
      return null;
    case "json":
      return v.v;
    default:
      return v.v;
  }
}

export function buildExport(
  format: ExportFormat,
  columns: ColumnMeta[],
  rows: Row[],
  tableName = "exported",
  options: ExportOptions = {},
): string {
  switch (format) {
    case "csv": {
      const sep = options.csvSeparator || DEFAULT_CSV_SEPARATOR;
      const header = columns.map((c) => csvEscape(c.name, sep)).join(sep);
      const body = rows.map((row) =>
        row.map((v) => (v.t === "null" ? "" : csvEscape(dbValueToDisplay(v), sep))).join(sep),
      );
      return [header, ...body].join("\n");
    }
    case "json": {
      const objects = rows.map((row) =>
        Object.fromEntries(columns.map((c, i) => [c.name, cellRaw(row[i])])),
      );
      return JSON.stringify(objects, null, 2);
    }
    case "sql": {
      const cols = columns.map((c) => `"${c.name}"`).join(", ");
      return rows
        .map(
          (row) =>
            `INSERT INTO "${tableName}" (${cols}) VALUES (${row
              .map(sqlLiteral)
              .join(", ")});`,
        )
        .join("\n");
    }
  }
}

const EXTENSIONS: Record<ExportFormat, string> = { csv: "csv", json: "json", sql: "sql" };

export async function exportResult(
  format: ExportFormat,
  columns: ColumnMeta[],
  rows: Row[],
  tableName?: string,
  options: ExportOptions = {},
): Promise<boolean> {
  const ext = EXTENSIONS[format];
  const path = await save({
    defaultPath: `${tableName ?? "result"}.${ext}`,
    filters: [{ name: format.toUpperCase(), extensions: [ext] }],
  });
  if (!path) return false;
  await ipc.saveTextFile(path, buildExport(format, columns, rows, tableName, options));
  return true;
}
