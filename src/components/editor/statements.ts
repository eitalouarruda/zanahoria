/** Rango [from, to) de un statement dentro del documento, sin el ';' final. */
export interface StatementRange {
  from: number;
  to: number;
}

/**
 * Divide el SQL en statements por ';', ignorando los que aparecen dentro de
 * strings ('...'), identificadores ("..." / `...`), comentarios (-- y /* *\/)
 * y bloques dollar-quoted de Postgres ($tag$...$tag$).
 */
export function splitStatements(sql: string): StatementRange[] {
  const out: StatementRange[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  const skipQuoted = (quote: string) => {
    i++;
    while (i < n) {
      if (sql[i] === quote) {
        // Comilla duplicada = escape ('' o "").
        if (sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        i++;
        return;
      }
      if (sql[i] === "\\" && quote !== '"') i++;
      i++;
    }
  };

  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      skipQuoted(c);
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end === -1 ? n : end + m[0].length;
      } else {
        i++;
      }
    } else if (c === ";") {
      out.push({ from: start, to: i });
      i++;
      start = i;
    } else {
      i++;
    }
  }
  out.push({ from: start, to: n });
  return out;
}

/** True si el rango solo contiene espacios y/o comentarios. */
function isBlank(sql: string, r: StatementRange): boolean {
  const text = sql
    .slice(r.from, r.to)
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return text.trim() === "";
}

/** Recorta espacios iniciales/finales del rango. */
function trimRange(sql: string, r: StatementRange): StatementRange {
  let { from, to } = r;
  while (from < to && /\s/.test(sql[from])) from++;
  while (to > from && /\s/.test(sql[to - 1])) to--;
  return { from, to };
}

/**
 * Statement que contiene la posición del cursor. Si el cursor queda en un
 * tramo vacío (por ejemplo justo después del último ';'), se usa el
 * statement anterior no vacío, como hace TablePlus.
 */
export function statementAt(sql: string, pos: number): StatementRange | null {
  const ranges = splitStatements(sql);
  let idx = ranges.findIndex((r) => pos >= r.from && pos <= r.to);
  if (idx === -1) idx = ranges.length - 1;
  for (let k = idx; k >= 0; k--) {
    if (!isBlank(sql, ranges[k])) return trimRange(sql, ranges[k]);
  }
  for (let k = idx + 1; k < ranges.length; k++) {
    if (!isBlank(sql, ranges[k])) return trimRange(sql, ranges[k]);
  }
  return null;
}
