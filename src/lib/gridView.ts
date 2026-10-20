import type { ColumnMeta, DbValue, Row } from "../ipc/types";
import { dbValueToDisplay } from "../ipc/types";

/** Orden del grid: columna (por nombre) y sentido. */
export interface GridSort {
  col: string;
  dir: "asc" | "desc";
}

/** Valor numérico de una celda, o null si no es numérica. */
function numericOf(v: DbValue): number | null {
  switch (v.t) {
    case "int":
    case "float":
      return v.v;
    case "decimal": {
      const n = Number(v.v);
      return Number.isNaN(n) ? null : n;
    }
    case "bool":
      return v.v ? 1 : 0;
    default:
      return null;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Compara dos valores para ordenar ascendente; NULL siempre va al final. */
export function compareDbValues(a: DbValue, b: DbValue): number {
  if (a.t === "null" || b.t === "null") {
    return a.t === b.t ? 0 : a.t === "null" ? 1 : -1;
  }
  const na = numericOf(a);
  const nb = numericOf(b);
  if (na !== null && nb !== null) return na - nb;
  return collator.compare(dbValueToDisplay(a), dbValueToDisplay(b));
}

/**
 * Convierte el texto de un filtro de columna en un predicado:
 * - `texto`: contiene (sin distinguir mayúsculas)
 * - `!texto`: no contiene
 * - `=x` / `!=x` (o `<>x`): igual / distinto; `=null` / `!=null` para NULL
 * - `>x`, `>=x`, `<x`, `<=x`: numérico si ambos lo son; si no, por texto
 * Devuelve null si el filtro está vacío.
 */
export function parseRowFilter(text: string): ((v: DbValue) => boolean) | null {
  const raw = text.trim();
  if (!raw) return null;
  const m = /^(>=|<=|!=|<>|=|>|<|!)\s*(.*)$/.exec(raw);
  const op = m?.[1] ?? "";
  const arg = (m ? m[2] : raw).trim();
  const lower = arg.toLowerCase();
  const display = (v: DbValue) => dbValueToDisplay(v).toLowerCase();

  if (op === "") return (v) => v.t !== "null" && display(v).includes(lower);
  if (op === "!") return (v) => v.t === "null" || !display(v).includes(lower);

  const isNullArg = lower === "null";
  const argNum = arg !== "" && !Number.isNaN(Number(arg)) ? Number(arg) : null;
  const equals = (v: DbValue) => {
    if (isNullArg) return v.t === "null";
    if (v.t === "null") return false;
    const n = numericOf(v);
    if (n !== null && argNum !== null) return n === argNum;
    return display(v) === lower;
  };
  if (op === "=") return equals;
  if (op === "!=" || op === "<>") return (v) => !equals(v);

  const cmp = (v: DbValue): number | null => {
    if (v.t === "null" || arg === "") return null;
    const n = numericOf(v);
    if (n !== null && argNum !== null) return n - argNum;
    return collator.compare(dbValueToDisplay(v), arg);
  };
  const test: Record<string, (c: number) => boolean> = {
    ">": (c) => c > 0,
    ">=": (c) => c >= 0,
    "<": (c) => c < 0,
    "<=": (c) => c <= 0,
  };
  return (v) => {
    const c = cmp(v);
    return c !== null && test[op](c);
  };
}

/**
 * Índices de `rows` que quedan tras filtrar y ordenar. Los filtros y el orden
 * se refieren a columnas por nombre; los que no existen se ignoran.
 */
export function computeRowView(
  columns: ColumnMeta[],
  rows: Row[],
  filters: Record<string, string>,
  sort: GridSort | null,
): number[] {
  const colIndex = (name: string) => columns.findIndex((c) => c.name === name);
  const preds: { col: number; test: (v: DbValue) => boolean }[] = [];
  for (const [name, text] of Object.entries(filters)) {
    const col = colIndex(name);
    const test = parseRowFilter(text);
    if (col !== -1 && test) preds.push({ col, test });
  }
  let view = rows.map((_, i) => i);
  if (preds.length > 0) {
    view = view.filter((i) => preds.every((p) => p.test(rows[i][p.col])));
  }
  const sortCol = sort ? colIndex(sort.col) : -1;
  if (sort && sortCol !== -1) {
    const sign = sort.dir === "asc" ? 1 : -1;
    view.sort((a, b) => {
      const va = rows[a][sortCol];
      const vb = rows[b][sortCol];
      // NULL al final en ambos sentidos.
      if (va.t === "null" || vb.t === "null") return compareDbValues(va, vb) || a - b;
      return sign * compareDbValues(va, vb) || a - b;
    });
  }
  return view;
}
