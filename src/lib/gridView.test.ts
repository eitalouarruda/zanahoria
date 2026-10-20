import { describe, expect, it } from "vitest";
import type { ColumnMeta, DbValue, Row } from "../ipc/types";
import { computeRowView, parseRowFilter } from "./gridView";

const int = (v: number): DbValue => ({ t: "int", v });
const text = (v: string): DbValue => ({ t: "text", v });
const NULL: DbValue = { t: "null" };

const columns: ColumnMeta[] = [
  { name: "id", dbType: "int4" },
  { name: "name", dbType: "text" },
];
const rows: Row[] = [
  [int(3), text("carrot")],
  [int(10), text("Apple")],
  [NULL, text("banana")],
  [int(1), NULL],
];

describe("parseRowFilter", () => {
  const matches = (f: string, v: DbValue) => parseRowFilter(f)!(v);

  it("vacío no filtra", () => {
    expect(parseRowFilter("   ")).toBeNull();
  });

  it("contiene / no contiene sin distinguir mayúsculas", () => {
    expect(matches("APP", text("apple"))).toBe(true);
    expect(matches("x", text("apple"))).toBe(false);
    expect(matches("!app", text("apple"))).toBe(false);
    expect(matches("!app", NULL)).toBe(true);
  });

  it("igualdad, NULL y comparaciones numéricas", () => {
    expect(matches("=10", int(10))).toBe(true);
    expect(matches("=1", int(10))).toBe(false);
    expect(matches("=null", NULL)).toBe(true);
    expect(matches("!=null", int(1))).toBe(true);
    expect(matches(">5", int(10))).toBe(true);
    expect(matches(">5", int(3))).toBe(false);
    expect(matches("<= 3", int(3))).toBe(true);
    expect(matches(">5", NULL)).toBe(false);
  });

  it("compara texto (fechas ISO) cuando no es numérico", () => {
    const d: DbValue = { t: "date", v: "2026-05-01" };
    expect(matches(">=2026-01-01", d)).toBe(true);
    expect(matches("<2026-01-01", d)).toBe(false);
  });
});

describe("computeRowView", () => {
  it("ordena numérico asc/desc con NULL al final", () => {
    expect(computeRowView(columns, rows, {}, { col: "id", dir: "asc" })).toEqual([3, 0, 1, 2]);
    expect(computeRowView(columns, rows, {}, { col: "id", dir: "desc" })).toEqual([1, 0, 3, 2]);
  });

  it("ordena texto sin distinguir mayúsculas", () => {
    expect(computeRowView(columns, rows, {}, { col: "name", dir: "asc" })).toEqual([1, 2, 0, 3]);
  });

  it("filtra y ordena a la vez; ignora columnas inexistentes", () => {
    expect(
      computeRowView(columns, rows, { id: ">2", nope: "x" }, { col: "id", dir: "desc" }),
    ).toEqual([1, 0]);
  });
});
