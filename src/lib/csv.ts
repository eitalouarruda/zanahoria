import type { DbValue } from "../ipc/types";
import { dbValueToDisplay } from "../ipc/types";
import type { MessageKey } from "../i18n";

/** Separadores ofrecidos al exportar o copiar como CSV. */
export const CSV_SEPARATORS: { value: string; label: MessageKey }[] = [
  { value: ";", label: "export.sepSemicolon" },
  { value: ",", label: "export.sepComma" },
  { value: "\t", label: "export.sepTab" },
  { value: "|", label: "export.sepPipe" },
];

/** Entre comillas si contiene el separador, comillas o saltos (como el backend). */
export function csvEscape(value: string, sep: string): string {
  return /["\n\r]/.test(value) || value.includes(sep)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/** CSV de filas ya cargadas; NULL queda vacío, igual que al exportar. */
export function rowsToCsv(
  header: string[] | null,
  rows: DbValue[][],
  sep: string,
): string {
  const lines = rows.map((row) =>
    row.map((v) => (v.t === "null" ? "" : csvEscape(dbValueToDisplay(v), sep))).join(sep),
  );
  if (header) lines.unshift(header.map((h) => csvEscape(h, sep)).join(sep));
  return lines.join("\n");
}
