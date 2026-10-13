import { describe, expect, it } from "vitest";
import { ACTIONS, comboFromEvent, formatShortcut, keysFor, matchesCombo } from "./keymap";

const ev = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
  ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;

describe("matchesCombo", () => {
  it("compara modificadores exactos", () => {
    expect(matchesCombo(ev("k", { ctrlKey: true }), "Mod-k")).toBe(true);
    expect(matchesCombo(ev("k", { ctrlKey: true, shiftKey: true }), "Mod-k")).toBe(false);
    expect(matchesCombo(ev("P", { ctrlKey: true, shiftKey: true }), "Mod-Shift-p")).toBe(true);
  });

  it("reconoce Space y la tecla '-'", () => {
    expect(matchesCombo(ev(" ", { ctrlKey: true }), "Mod-Space")).toBe(true);
    expect(matchesCombo(ev("-", { ctrlKey: true }), "Mod--")).toBe(true);
  });
});

describe("comboFromEvent", () => {
  it("genera el mismo formato que el registro", () => {
    expect(comboFromEvent(ev("o", { ctrlKey: true }))).toBe("Mod-o");
    expect(comboFromEvent(ev("ArrowLeft"))).toBe("ArrowLeft");
    expect(comboFromEvent(ev(" ", { ctrlKey: true, shiftKey: true }))).toBe("Mod-Shift-Space");
  });
});

describe("formatShortcut", () => {
  it("muestra combinaciones y secuencias legibles", () => {
    expect(formatShortcut("Mod-Shift-p")).toBe("Ctrl+Shift+P");
    expect(formatShortcut("Mod-Space ArrowLeft")).toBe("Ctrl+Space ←");
  });
});

describe("registro de acciones", () => {
  it("las redefiniciones reemplazan a los defaults", () => {
    expect(keysFor("openDatabase", {})).toEqual(["Mod-k"]);
    expect(keysFor("openDatabase", { openDatabase: ["Mod-o"] })).toEqual(["Mod-o"]);
  });

  it("no hay dos acciones con el mismo atajo por defecto", () => {
    const seen = new Map<string, string>();
    for (const a of ACTIONS) {
      for (const k of a.defaults) {
        expect(seen.get(k), `${k} en ${a.id} y ${seen.get(k)}`).toBeUndefined();
        seen.set(k, a.id);
      }
    }
  });
});
