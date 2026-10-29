import { describe, expect, it } from "vitest";
import { dbTypeKind, displayToDbValue } from "./types";

describe("displayToDbValue", () => {
  it("keeps the original cell type", () => {
    expect(displayToDbValue("7", { t: "int", v: 1 })).toEqual({ t: "int", v: 7 });
    expect(displayToDbValue("x", { t: "text", v: "a" })).toEqual({ t: "text", v: "x" });
  });

  it("uses the column type when the original cell is NULL", () => {
    expect(displayToDbValue("1", { t: "null" }, "INT4")).toEqual({ t: "int", v: 1 });
    expect(displayToDbValue("1.5", { t: "null" }, "NUMERIC")).toEqual({ t: "decimal", v: "1.5" });
    expect(displayToDbValue("true", { t: "null" }, "BOOL")).toEqual({ t: "bool", v: true });
    expect(displayToDbValue("1", { t: "null" }, "VARCHAR")).toEqual({ t: "text", v: "1" });
    expect(displayToDbValue("1", { t: "null" })).toEqual({ t: "text", v: "1" });
  });

  it("returns NULL for empty text", () => {
    expect(displayToDbValue("", { t: "null" }, "INT4")).toEqual({ t: "null" });
  });
});

describe("dbTypeKind", () => {
  it("maps Postgres, MySQL and SQLite type names", () => {
    expect(dbTypeKind("INT8")).toBe("int");
    expect(dbTypeKind("BIGINT UNSIGNED")).toBe("int");
    expect(dbTypeKind("INTEGER")).toBe("int");
    expect(dbTypeKind("DOUBLE")).toBe("float");
    expect(dbTypeKind("DATETIME")).toBe("timestamp");
    expect(dbTypeKind("TIMESTAMPTZ")).toBe("timestamp");
    expect(dbTypeKind("UUID")).toBe("uuid");
    expect(dbTypeKind("INT4[]")).toBeNull();
    expect(dbTypeKind("TEXT")).toBeNull();
  });
});
