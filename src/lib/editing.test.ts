import { describe, expect, it } from "vitest";
import type { ColumnMeta, DbValue, Editability, Row } from "../ipc/types";
import {
  buildPendingChanges,
  checkEditability,
  editedCells,
  editedValue,
  isCellEditable,
  isInsertCellEditable,
} from "./editing";

const int = (v: number): DbValue => ({ t: "int", v });
const text = (v: string): DbValue => ({ t: "text", v });
const NULL: DbValue = { t: "null" };

// SELECT v.id, v.secuencial, e.id, e.nombre FROM ventas v LEFT JOIN entidades e ...
const join: Editability = {
  editable: true,
  reason: null,
  targets: [
    {
      namespace: null,
      table: "ventas",
      alias: "v",
      pkColumns: ["id"],
      pkIndexes: [0],
      editable: true,
      reason: null,
    },
    {
      namespace: null,
      table: "entidades",
      alias: "e",
      pkColumns: ["id"],
      pkIndexes: [2],
      editable: true,
      reason: null,
    },
  ],
  columns: [
    { name: "id", source: { target: 0, column: "id" } },
    { name: "secuencial", source: { target: 0, column: "secuencial" } },
    { name: "id", source: { target: 1, column: "id" } },
    { name: "nombre", source: { target: 1, column: "nombre" } },
  ],
  rowTarget: null,
};
const columns: ColumnMeta[] = ["id", "secuencial", "id", "nombre"].map((name) => ({
  name,
  dbType: "text",
}));
const rows: Row[] = [
  [int(1), text("001"), int(9), text("ACME")],
  [int(2), text("002"), int(9), text("ACME")],
  [int(3), text("003"), NULL, NULL],
];

describe("checkEditability", () => {
  it("acepta columnas que coinciden (sin distinguir mayúsculas)", () => {
    const upper = columns.map((c) => ({ ...c, name: c.name.toUpperCase() }));
    expect(checkEditability(join, upper)?.editable).toBe(true);
  });

  it("desactiva la edición si el motor devolvió otras columnas", () => {
    const e = checkEditability(join, columns.slice(1));
    expect(e?.editable).toBe(false);
    expect(e?.reason).toMatch(/refresh schema/);
  });
});

describe("editabilidad por celda", () => {
  it("LEFT JOIN sin match: la tabla de la derecha no se edita en esa fila", () => {
    expect(isCellEditable(join, rows[2], 1)).toBe(true);
    expect(isCellEditable(join, rows[2], 3)).toBe(false);
    expect(isCellEditable(join, rows[0], 3)).toBe(true);
  });

  it("sin rowTarget no hay inserts", () => {
    expect(isInsertCellEditable(join, 1)).toBe(false);
    expect(isInsertCellEditable({ ...join, rowTarget: 0 }, 1)).toBe(true);
    expect(isInsertCellEditable({ ...join, rowTarget: 0 }, 3)).toBe(false);
  });
});

describe("ediciones con JOIN", () => {
  const changes = {
    0: {
      kind: "update" as const,
      values: { 1: text("010"), 3: text("ACME SA") },
      oldValues: { 1: text("001"), 3: text("ACME") },
    },
  };

  it("la edición de una fila real se ve en todas las filas que la muestran", () => {
    const edited = editedCells(join, rows, changes);
    expect(editedValue(join, edited, rows[1], 3)).toEqual(text("ACME SA"));
    expect(editedValue(join, edited, rows[1], 1)).toBeUndefined();
  });

  it("genera un UPDATE por tabla con su PK", () => {
    expect(buildPendingChanges(join, rows, changes, [])).toEqual([
      {
        kind: "update",
        target: 0,
        pk: { id: int(1) },
        values: { secuencial: text("010") },
        oldValues: { secuencial: text("001") },
      },
      {
        kind: "update",
        target: 1,
        pk: { id: int(9) },
        values: { nombre: text("ACME SA") },
        oldValues: { nombre: text("ACME") },
      },
    ]);
  });

  it("ignora borrados cuando la query tiene JOIN", () => {
    const del = { 0: { kind: "delete" as const, values: {}, oldValues: {} } };
    expect(buildPendingChanges(join, rows, del, [])).toEqual([]);
    expect(buildPendingChanges({ ...join, rowTarget: 0 }, rows, del, [])).toEqual([
      { kind: "delete", target: 0, pk: { id: int(1) }, values: {}, oldValues: {} },
    ]);
  });
});
