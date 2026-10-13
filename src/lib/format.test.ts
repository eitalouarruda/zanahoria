import { describe, expect, it } from "vitest";
import { uglify } from "./format";

describe("uglify", () => {
  it("colapsa espacios y saltos de línea", () => {
    expect(uglify("SELECT *\n  FROM   t\n\tWHERE id = 1;")).toBe("SELECT * FROM t WHERE id = 1;");
  });

  it("no toca strings ni identificadores entre comillas", () => {
    expect(uglify("SELECT 'a   b',\n \"x  y\" FROM t")).toBe("SELECT 'a   b', \"x  y\" FROM t");
  });

  it("convierte comentarios de línea en comentarios de bloque", () => {
    expect(uglify("SELECT 1 -- uno\nFROM t")).toBe("SELECT 1 /* uno */ FROM t");
  });
});
