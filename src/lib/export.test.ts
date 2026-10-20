import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../ipc/commands", () => ({ ipc: {} }));

const { buildExport } = await import("./export");

const columns = [
  { name: "id", dbType: "int4" },
  { name: "name", dbType: "text" },
];
const rows = [
  [{ t: "int", v: 1 }, { t: "text", v: "a;b" }],
  [{ t: "int", v: 2 }, { t: "null" }],
] as const;

describe("buildExport csv", () => {
  it("usa ; por defecto y entrecomilla valores que lo contienen", () => {
    expect(buildExport("csv", columns, rows as never)).toBe('id;name\n1;"a;b"\n2;');
  });

  it("respeta el separador elegido", () => {
    expect(buildExport("csv", columns, rows as never, undefined, { csvSeparator: "\t" })).toBe(
      "id\tname\n1\ta;b\n2\t",
    );
  });
});
