import { describe, expect, it } from "vitest";
import { splitStatements, statementAt } from "./statements";
import { tableRefs } from "./sqlCompletion";

const at = (sql: string, marker = "|") => {
  const pos = sql.indexOf(marker);
  const doc = sql.replace(marker, "");
  const r = statementAt(doc, pos);
  return r ? doc.slice(r.from, r.to) : null;
};

describe("splitStatements", () => {
  it("ignora ';' en strings, identificadores, comentarios y dollar quotes", () => {
    const sql = `SELECT ';' AS a; SELECT "x;y" FROM t -- c;\n; SELECT $$ a; b $$; /* ; */ SELECT 1`;
    expect(splitStatements(sql)).toHaveLength(4);
  });

  it("respeta comillas escapadas duplicadas", () => {
    expect(splitStatements(`SELECT 'it''s; ok'; SELECT 2`)).toHaveLength(2);
  });
});

describe("statementAt", () => {
  it("devuelve el statement bajo el cursor", () => {
    expect(at("SELECT 1;\nSELECT |2;\nSELECT 3;")).toBe("SELECT 2");
  });

  it("tras el último ';' usa el statement anterior", () => {
    expect(at("SELECT 1;\nSELECT 2;\n|")).toBe("SELECT 2");
  });

  it("sin ';' devuelve todo el texto recortado", () => {
    expect(at("  SELECT *\n  FROM t|  ")).toBe("SELECT *\n  FROM t");
  });

  it("documento vacío o solo comentarios → null", () => {
    expect(at("-- nada |")).toBeNull();
  });
});

describe("tableRefs", () => {
  it("detecta tablas, schema y alias en FROM/JOIN", () => {
    const refs = tableRefs(
      `SELECT * FROM public.users u JOIN orders AS o ON o.user_id = u.id WHERE u.id = 1`,
    );
    expect(refs).toEqual([
      { namespace: "public", table: "users", alias: "u" },
      { namespace: null, table: "orders", alias: "o" },
    ]);
  });

  it("FROM con lista separada por comas y sin alias", () => {
    expect(tableRefs(`SELECT * FROM a, b x WHERE 1=1`)).toEqual([
      { namespace: null, table: "a", alias: null },
      { namespace: null, table: "b", alias: "x" },
    ]);
  });

  it("identificadores con comillas y UPDATE/INTO", () => {
    expect(tableRefs("UPDATE `A big Table` SET x = 1")).toEqual([
      { namespace: null, table: "A big Table", alias: null },
    ]);
    expect(tableRefs(`INSERT INTO "comments" (id) VALUES (1)`)[0].table).toBe("comments");
  });

  it("no confunde keywords con alias ni mira dentro de strings", () => {
    expect(tableRefs(`SELECT 'from fake' FROM t WHERE x = 1`)).toEqual([
      { namespace: null, table: "t", alias: null },
    ]);
  });
});
