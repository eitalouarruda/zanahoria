import { describe, expect, it } from "vitest";
import { rowsToCsv } from "./csv";

describe("rowsToCsv", () => {
  const rows = [
    [{ t: "int", v: 1 } as const, { t: "text", v: "Ana; Pérez" } as const, { t: "null" } as const],
    [{ t: "int", v: 2 } as const, { t: "text", v: 'dice "hola"' } as const, { t: "bool", v: true } as const],
  ];

  it("incluye la cabecera y escapa separador y comillas", () => {
    expect(rowsToCsv(["id", "nombre", "activo"], rows, ";")).toBe(
      'id;nombre;activo\n1;"Ana; Pérez";\n2;"dice ""hola""";true',
    );
  });

  it("sin cabecera, con otro separador", () => {
    expect(rowsToCsv(null, rows, ",")).toBe('1,Ana; Pérez,\n2,"dice ""hola""",true');
  });

  it("escapa saltos de línea", () => {
    expect(rowsToCsv(null, [[{ t: "text", v: "a\nb" }]], "\t")).toBe('"a\nb"');
  });
});
