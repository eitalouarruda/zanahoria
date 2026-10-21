import { save } from "@tauri-apps/plugin-dialog";
import { ipc } from "../ipc/commands";
import type { ResultState } from "../stores/workspaceStore";

export type ExportFormat = "csv" | "json" | "sql" | "xlsx";

/** Separador de CSV por defecto (el que espera Excel en locales con coma decimal). */
export const DEFAULT_CSV_SEPARATOR = ";";

export interface ExportOptions {
  /** Separador de campos del CSV. */
  csvSeparator?: string;
  /** Tabla destino de los INSERT del formato SQL. */
  tableName?: string;
}

/**
 * Cómo se exporta un resultado. Siempre se exporta TODO lo que devuelve la
 * consulta, nunca lo filtrado/ordenado en el grid:
 * - "query": se re-ejecuta en el backend sin límite de filas (solo lectura).
 * - "rows": la consulta no se puede re-ejecutar sin efectos, pero su
 *   resultado ya está completo en memoria.
 * - "blocked": no se puede re-ejecutar y el resultado está incompleto.
 */
export type ExportPlan =
  | { mode: "query"; sql: string }
  | { mode: "rows"; total: number }
  | { mode: "blocked"; loaded: number };

export function exportPlan(result: ResultState): ExportPlan {
  if (result.readOnly && result.executedSql) return { mode: "query", sql: result.executedSql };
  if (!result.truncated && !result.running) return { mode: "rows", total: result.rows.length };
  return { mode: "blocked", loaded: result.rows.length };
}

const EXTENSIONS: Record<ExportFormat, string> = {
  csv: "csv",
  json: "json",
  sql: "sql",
  xlsx: "xlsx",
};

export interface ExportTarget {
  connId: string;
  database: string;
  result: ResultState;
  /** Id para cancelar con `ipc.cancelQuery` y seguir el progreso. */
  exportId: string;
  /** Se llama al empezar a escribir (tras elegir el archivo). */
  onStart?: () => void;
}

/**
 * Pide el archivo destino y exporta según `exportPlan`. Devuelve las filas
 * exportadas, o null si el usuario canceló el diálogo de guardado.
 */
export async function exportResult(
  format: ExportFormat,
  target: ExportTarget,
  options: ExportOptions = {},
): Promise<number | null> {
  const plan = exportPlan(target.result);
  if (plan.mode === "blocked") throw new Error("export blocked: incomplete result");
  const ext = EXTENSIONS[format];
  const path = await save({
    defaultPath: `${options.tableName ?? "result"}.${ext}`,
    filters: [{ name: format.toUpperCase(), extensions: [ext] }],
  });
  if (!path) return null;
  target.onStart?.();
  const summary =
    plan.mode === "query"
      ? await ipc.exportQuery({
          exportId: target.exportId,
          connId: target.connId,
          database: target.database,
          sql: plan.sql,
          format,
          path,
          options,
        })
      : await ipc.exportRows({
          path,
          format,
          columns: target.result.columns,
          rows: target.result.rows,
          options,
        });
  return summary.rows;
}
