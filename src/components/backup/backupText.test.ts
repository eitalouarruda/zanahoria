import { describe, expect, it } from "vitest";
import {
  defaultBackupName,
  explainResult,
  formatBytes,
  suggestDbName,
  versionLabel,
} from "./backupText";

describe("suggestDbName", () => {
  it("prefers the file name", () => {
    expect(suggestDbName("athos", "/x/candelaria.dump", [])).toBe("candelaria");
    expect(suggestDbName("amicci_a3", "/x/amicci_a3.dump", [])).toBe("amicci_a3");
  });

  it("strips dates and backup words", () => {
    expect(suggestDbName("prod", "/x/prod_backup_2026-10-28_04-03-33.dump", [])).toBe("prod");
    expect(suggestDbName("shop", "C:\\bkp\\bkp-2025-01-02.sql.gz", [])).toBe("shop");
  });

  it("never repeats an existing database", () => {
    expect(suggestDbName(null, "/x/nt.sql", ["nt", "nt_2"])).toBe("nt_3");
  });

  it("sanitizes names", () => {
    expect(suggestDbName(null, "/x/Gestão Loja.sql", [])).toBe("gestao_loja");
    expect(suggestDbName(null, "/x/2024.sql", [])).toBe("db_2024");
  });
});

describe("explainResult", () => {
  it("reads restore verification", () => {
    const r = explainResult([], { success: true, message: "completed — verify: 268 tables expected, 268 found" });
    expect(r).toMatchObject({ code: "bk.ok.tables", params: { n: "268" } });
  });

  it("recognizes common failures", () => {
    const log = ['psql:<stdin>:48: ERROR:  type "cep" already exists'];
    const r = explainResult(log, { success: false, message: "exited with exit status: 3" });
    expect(r.code).toBe("bk.err.exists");
    expect(r.lastError).toBe(log[0]);
  });

  it("falls back to the raw error", () => {
    const r = explainResult(["something odd"], { success: false, message: "exited with 1" });
    expect(r).toMatchObject({ code: "bk.err.generic", known: false, lastError: "exited with 1" });
  });
});

describe("formatting", () => {
  it("formats sizes and versions", () => {
    expect(formatBytes(31151317)).toBe("30 MB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(versionLabel("18.6 (Debian 18.6-1.pgdg13+2)")).toBe("18.6");
    expect(versionLabel("pg_dump (PostgreSQL) 18.6")).toBe("18.6");
  });

  it("names backup files", () => {
    const d = new Date(2026, 9, 28, 9, 5);
    expect(defaultBackupName("Vendas", "postgres", "custom", d)).toBe("vendas_2026-10-28_0905.dump");
    expect(defaultBackupName("x", "mysql", "plain", d)).toBe("x_2026-10-28_0905.sql");
  });
});
