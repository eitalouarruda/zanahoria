import { describe, expect, it, vi } from "vitest";
import type { ResultState } from "../stores/workspaceStore";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../ipc/commands", () => ({ ipc: {} }));

const { exportPlan } = await import("./export");

const result = (over: Partial<ResultState>): ResultState =>
  ({
    rows: new Array(10_000).fill([]),
    truncated: true,
    running: false,
    readOnly: true,
    executedSql: "SELECT * FROM t",
    ...over,
  }) as ResultState;

describe("exportPlan", () => {
  it("re-ejecuta las consultas de solo lectura aunque el grid esté truncado", () => {
    expect(exportPlan(result({}))).toEqual({ mode: "query", sql: "SELECT * FROM t" });
  });

  it("si no es de solo lectura usa las filas cargadas cuando están todas", () => {
    expect(exportPlan(result({ readOnly: false, truncated: false }))).toEqual({
      mode: "rows",
      total: 10_000,
    });
  });

  it("bloquea si no es de solo lectura y el resultado está incompleto", () => {
    expect(exportPlan(result({ readOnly: false }))).toEqual({ mode: "blocked", loaded: 10_000 });
    expect(exportPlan(result({ readOnly: false, truncated: false, running: true }))).toEqual({
      mode: "blocked",
      loaded: 10_000,
    });
  });
});
