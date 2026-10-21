import { describe, expect, it } from "vitest";
import { matchesConnection } from "./connectionFilter";
import type { SavedConnection } from "../ipc/types";

const conn = {
  id: "1",
  name: "Producción ERP",
  engine: "postgres",
  host: "db.example.com",
  port: 5432,
  user: "admin",
  database: "erp",
  group: "Clientes",
} as SavedConnection;

describe("matchesConnection", () => {
  it("filtro vacío deja pasar todo", () => {
    expect(matchesConnection(conn, "  ")).toBe(true);
  });

  it("busca en nombre, grupo, motor, host y database sin importar mayúsculas", () => {
    expect(matchesConnection(conn, "erp")).toBe(true);
    expect(matchesConnection(conn, "CLIENTES")).toBe(true);
    expect(matchesConnection(conn, "postgres example")).toBe(true);
  });

  it("exige todas las palabras", () => {
    expect(matchesConnection(conn, "erp mysql")).toBe(false);
  });
});
