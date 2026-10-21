import type { ErrorPosition } from "../ipc/types";
import { splitStatements } from "../components/editor/statements";

/** Ubicación de un error de query, lista para mostrar y marcar en el editor. */
export interface ErrorLocation {
  /** Línea y columna 1-based (en el editor si `offset` no es null; si no, en el SQL ejecutado). */
  line: number;
  col: number;
  /** Offset en el documento del editor (null si el texto ya no coincide). */
  offset: number | null;
}

/** Offset (UTF-16) dentro de `sql` del error reportado por el motor. */
export function localErrorOffset(sql: string, pos: ErrorPosition): number | null {
  if (pos.kind === "offset") {
    // Postgres cuenta caracteres (code points), JS indexa en UTF-16.
    let i = 0;
    for (let n = 0; n < pos.offset && i < sql.length; n++) {
      i += sql.codePointAt(i)! > 0xffff ? 2 : 1;
    }
    return Math.min(i, sql.length);
  }
  // MySQL: línea relativa al statement que falló, contada desde su primer
  // carácter no blanco.
  const range = splitStatements(sql)[pos.statement];
  if (!range) return null;
  let i = range.from;
  while (i < range.to && /\s/.test(sql[i])) i++;
  for (let line = 1; line < pos.line; line++) {
    const nl = sql.indexOf("\n", i);
    if (nl === -1) return null;
    i = nl + 1;
  }
  // Sin columna: apuntar al primer carácter no blanco de la línea.
  while (i < sql.length && (sql[i] === " " || sql[i] === "\t")) i++;
  return i;
}

function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, col: offset - before.lastIndexOf("\n") };
}

/**
 * Traduce la posición del motor a línea/columna del editor. `executedFrom` es
 * dónde empezaba `executedSql` dentro de `doc` al ejecutar; si el documento
 * cambió desde entonces, la ubicación queda relativa al SQL ejecutado.
 */
export function locateError(
  doc: string,
  executedSql: string,
  executedFrom: number | null,
  pos: ErrorPosition,
): ErrorLocation | null {
  const local = localErrorOffset(executedSql, pos);
  if (local === null) return null;
  const inDoc =
    executedFrom !== null &&
    doc.slice(executedFrom, executedFrom + executedSql.length) === executedSql;
  if (!inDoc) return { ...lineCol(executedSql, local), offset: null };
  const offset = executedFrom + local;
  return { ...lineCol(doc, offset), offset };
}
