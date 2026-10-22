import type { ColumnMeta, DbValue, Editability, PendingChange, Row } from "../ipc/types";

/** Cambio pendiente de una fila del resultado; valores por índice de columna. */
export interface RowChange {
  kind: "update" | "delete";
  values: Record<number, DbValue>;
  oldValues: Record<number, DbValue>;
}

/** Fila nueva: valores por índice de columna. */
export type InsertRow = Record<number, DbValue>;

/**
 * El análisis del backend supone qué columnas devuelve la query (expande `*`
 * con el schema). Si el motor devolvió otras, las posiciones no cuadran y
 * editar sería peligroso: se marca todo como read-only.
 */
export function checkEditability(
  e: Editability | null,
  columns: ColumnMeta[],
): Editability | null {
  if (!e?.editable || columns.length === 0) return e;
  const matches =
    e.columns.length === columns.length &&
    e.columns.every(
      (c, i) => c.name === null || c.name.toLowerCase() === columns[i].name.toLowerCase(),
    );
  if (matches) return e;
  return {
    ...e,
    editable: false,
    reason: "result columns do not match the schema (refresh schema?)",
    rowTarget: null,
  };
}

/** Tabla/columna real de la columna `col` del resultado, si es editable. */
export function editableSource(e: Editability | null, col: number) {
  if (!e?.editable) return null;
  const src = e.columns[col]?.source;
  return src && e.targets[src.target]?.editable ? src : null;
}

/** Valores de la PK de `target` en la fila (null si alguno es NULL: LEFT JOIN sin match). */
export function pkValues(e: Editability, target: number, row: Row): Record<string, DbValue> | null {
  const t = e.targets[target];
  const pk: Record<string, DbValue> = {};
  for (let k = 0; k < t.pkColumns.length; k++) {
    const v = row[t.pkIndexes[k]];
    if (!v || v.t === "null") return null;
    pk[t.pkColumns[k]] = v;
  }
  return pk;
}

/** Clave estable de una fila real: tabla + valores de su PK. */
export function rowKey(target: number, pk: Record<string, DbValue>): string {
  return `${target}|${JSON.stringify(Object.values(pk))}`;
}

/** Celda existente editable: su tabla es editable y la fila tiene PK. */
export function isCellEditable(e: Editability | null, row: Row, col: number): boolean {
  const src = editableSource(e, col);
  return !!src && pkValues(e!, src.target, row) !== null;
}

/** Celda de una fila nueva editable: sólo columnas de la tabla de inserción. */
export function isInsertCellEditable(e: Editability | null, col: number): boolean {
  const src = editableSource(e, col);
  return !!src && e!.rowTarget === src.target;
}

/**
 * Valores editados por fila real (`rowKey` + columna real): con JOIN, la misma
 * fila de una tabla puede aparecer en varias filas del resultado y la edición
 * debe verse en todas.
 */
export function editedCells(
  e: Editability | null,
  rows: Row[],
  changes: Record<number, RowChange>,
): Map<string, DbValue> {
  const out = new Map<string, DbValue>();
  if (!e?.editable) return out;
  for (const [rowStr, change] of Object.entries(changes)) {
    const row = rows[Number(rowStr)];
    if (!row || change.kind !== "update") continue;
    for (const [colStr, value] of Object.entries(change.values)) {
      const src = editableSource(e, Number(colStr));
      const pk = src && pkValues(e, src.target, row);
      if (src && pk) out.set(`${rowKey(src.target, pk)}|${src.column}`, value);
    }
  }
  return out;
}

/** Valor editado de la celda (por ella misma u otra fila con la misma fila real). */
export function editedValue(
  e: Editability | null,
  edited: Map<string, DbValue>,
  row: Row,
  col: number,
): DbValue | undefined {
  if (edited.size === 0) return undefined;
  const src = editableSource(e, col);
  const pk = src && pkValues(e!, src.target, row);
  return src && pk ? edited.get(`${rowKey(src.target, pk)}|${src.column}`) : undefined;
}

/** Convierte el estado del grid a PendingChange[] para preview/apply. */
export function buildPendingChanges(
  e: Editability | null,
  rows: Row[],
  changes: Record<number, RowChange>,
  inserts: InsertRow[],
): PendingChange[] {
  if (!e?.editable) return [];
  const out: PendingChange[] = [];
  const indexes = Object.keys(changes)
    .map(Number)
    .sort((a, b) => a - b);
  for (const rowIndex of indexes) {
    const change = changes[rowIndex];
    const row = rows[rowIndex];
    if (!row) continue;
    if (change.kind === "delete") {
      if (e.rowTarget === null) continue;
      const pk = pkValues(e, e.rowTarget, row);
      if (pk) out.push({ kind: "delete", target: e.rowTarget, pk, values: {}, oldValues: {} });
      continue;
    }
    // Un UPDATE por tabla tocada en la fila (el backend une los de la misma fila real).
    const byTarget = new Map<number, PendingChange>();
    for (const [colStr, value] of Object.entries(change.values)) {
      const col = Number(colStr);
      const src = editableSource(e, col);
      const pk = src && pkValues(e, src.target, row);
      if (!src || !pk) continue;
      let pc = byTarget.get(src.target);
      if (!pc) {
        pc = { kind: "update", target: src.target, pk, values: {}, oldValues: {} };
        byTarget.set(src.target, pc);
        out.push(pc);
      }
      pc.values[src.column] = value;
      pc.oldValues[src.column] = change.oldValues[col] ?? row[col];
    }
  }
  if (e.rowTarget !== null) {
    for (const insert of inserts) {
      const values: Record<string, DbValue> = {};
      for (const [colStr, value] of Object.entries(insert)) {
        const src = editableSource(e, Number(colStr));
        if (src?.target === e.rowTarget && value.t !== "null") values[src.column] = value;
      }
      if (Object.keys(values).length > 0) {
        out.push({ kind: "insert", target: e.rowTarget, pk: {}, values, oldValues: {} });
      }
    }
  }
  return out;
}

/** Tabla para los INSERT exportados: sólo si la query lee una única tabla. */
export function exportTableName(e: Editability | null): string | undefined {
  return e?.rowTarget != null ? e.targets[e.rowTarget]?.table : undefined;
}
