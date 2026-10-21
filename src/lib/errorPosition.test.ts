import { describe, expect, it } from "vitest";
import { localErrorOffset, locateError } from "./errorPosition";

describe("localErrorOffset", () => {
  it("convierte offsets de Postgres (code points) a UTF-16", () => {
    const sql = "SELECT '😀', (1 + )";
    const cp = [...sql].indexOf(")");
    expect(localErrorOffset(sql, { kind: "offset", offset: cp })).toBe(sql.indexOf(")"));
  });

  it("ubica la línea de MySQL dentro del statement que falló", () => {
    const sql = "SELECT 1;\nSELECT 2;\n\nSELECT\n  (1 + );";
    const off = localErrorOffset(sql, { kind: "line", line: 2, statement: 2 });
    expect(off).toBe(sql.indexOf("(1 + )"));
  });

  it("null si el statement no existe", () => {
    expect(localErrorOffset("SELECT 1", { kind: "line", line: 1, statement: 3 })).toBeNull();
  });
});

describe("locateError", () => {
  const doc = "SELECT 1;\n\nSELECT\n  (1 + );";
  const executed = "SELECT\n  (1 + );";
  const from = doc.indexOf(executed);
  const pos = { kind: "offset" as const, offset: executed.indexOf(")") };

  it("traduce a línea/columna del editor", () => {
    expect(locateError(doc, executed, from, pos)).toEqual({
      line: 4,
      col: 8,
      offset: doc.indexOf(")"),
    });
  });

  it("si el documento cambió, queda relativa al SQL ejecutado", () => {
    expect(locateError("otro texto", executed, from, pos)).toEqual({
      line: 2,
      col: 8,
      offset: null,
    });
  });
});
