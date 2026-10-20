import type { MessageKey } from "../i18n";

/**
 * Registro central de atajos. Cada acción tiene sus teclas por defecto; el
 * usuario puede redefinirlas en Settings → Keyboard shortcuts.
 *
 * Formato de una combinación: "Mod-Shift-Alt-<tecla>" (Mod = Ctrl, o Cmd en
 * macOS). Una secuencia estilo tmux separa los pasos con espacio:
 * "Mod-Space ArrowLeft" = Ctrl+Space y luego ←.
 */
export type ActionId =
  | "openDatabase"
  | "newConnection"
  | "nextWorkspace"
  | "prevWorkspace"
  | "closeWorkspace"
  | "openSettings"
  | "quit"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "uiZoomIn"
  | "uiZoomOut"
  | "uiZoomReset"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "runCurrent"
  | "runAll"
  | "reload"
  | "beautify"
  | "uglify"
  | "toggleComment"
  | "toggleBlockComment"
  | "toggleSplit"
  | "focusLeftPane"
  | "focusRightPane"
  | "previewChanges"
  | "commitChanges";

export type ActionGroup = "general" | "tabs" | "editor" | "results";

export interface ActionDef {
  id: ActionId;
  group: ActionGroup;
  label: MessageKey;
  defaults: string[];
}

export const ACTIONS: ActionDef[] = [
  { id: "openDatabase", group: "general", label: "action.openDatabase", defaults: ["Mod-k"] },
  { id: "newConnection", group: "general", label: "action.newConnection", defaults: ["Mod-n", "Mod-Shift-n"] },
  { id: "nextWorkspace", group: "general", label: "action.nextWorkspace", defaults: ["Mod-Shift-]", "Mod-Shift-}"] },
  { id: "prevWorkspace", group: "general", label: "action.prevWorkspace", defaults: ["Mod-Shift-[", "Mod-Shift-{"] },
  { id: "closeWorkspace", group: "general", label: "action.closeWorkspace", defaults: ["Mod-Escape"] },
  { id: "openSettings", group: "general", label: "action.openSettings", defaults: ["Mod-,"] },
  { id: "quit", group: "general", label: "action.quit", defaults: ["Mod-q"] },
  { id: "zoomIn", group: "general", label: "action.zoomIn", defaults: ["Mod-=", "Mod-+", "Mod-Shift-+"] },
  { id: "zoomOut", group: "general", label: "action.zoomOut", defaults: ["Mod--"] },
  { id: "zoomReset", group: "general", label: "action.zoomReset", defaults: ["Mod-0"] },
  { id: "uiZoomIn", group: "general", label: "action.uiZoomIn", defaults: ["Mod-Alt-=", "Mod-Alt-+", "Mod-Alt-Shift-+"] },
  { id: "uiZoomOut", group: "general", label: "action.uiZoomOut", defaults: ["Mod-Alt--"] },
  { id: "uiZoomReset", group: "general", label: "action.uiZoomReset", defaults: ["Mod-Alt-0"] },

  { id: "newTab", group: "tabs", label: "action.newTab", defaults: ["Mod-t"] },
  { id: "closeTab", group: "tabs", label: "action.closeTab", defaults: ["Mod-w"] },
  { id: "nextTab", group: "tabs", label: "action.nextTab", defaults: ["Mod-]", "Mod-Tab", "Mod-PageDown"] },
  { id: "prevTab", group: "tabs", label: "action.prevTab", defaults: ["Mod-[", "Mod-Shift-Tab", "Mod-PageUp"] },

  { id: "runCurrent", group: "editor", label: "action.runCurrent", defaults: ["Mod-Enter"] },
  { id: "runAll", group: "editor", label: "action.runAll", defaults: ["Mod-Shift-Enter"] },
  { id: "reload", group: "editor", label: "action.reload", defaults: ["Mod-r", "F5"] },
  { id: "beautify", group: "editor", label: "action.beautify", defaults: ["Mod-i"] },
  { id: "uglify", group: "editor", label: "action.uglify", defaults: ["Mod-Shift-i"] },
  { id: "toggleComment", group: "editor", label: "action.toggleComment", defaults: ["Mod-/"] },
  { id: "toggleBlockComment", group: "editor", label: "action.toggleBlockComment", defaults: ["Mod-Alt-/"] },
  { id: "toggleSplit", group: "editor", label: "action.toggleSplit", defaults: ["Mod-\\"] },
  { id: "focusLeftPane", group: "editor", label: "action.focusLeftPane", defaults: ["Mod-Space ArrowLeft"] },
  { id: "focusRightPane", group: "editor", label: "action.focusRightPane", defaults: ["Mod-Space ArrowRight"] },

  { id: "previewChanges", group: "results", label: "action.previewChanges", defaults: ["Mod-Shift-p"] },
  { id: "commitChanges", group: "results", label: "action.commitChanges", defaults: ["Mod-s"] },
];

export const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a])) as Record<
  ActionId,
  ActionDef
>;

export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** Teclas efectivas de una acción (redefinidas por el usuario o default). */
export function keysFor(action: ActionId, overrides: Partial<Record<ActionId, string[]>>): string[] {
  return overrides[action] ?? ACTION_BY_ID[action].defaults;
}

/** Nombre normalizado de la tecla de un evento (" " → "Space"). */
export function eventKeyName(e: KeyboardEvent): string {
  if (e.key === " ") return "Space";
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]);

export function isModifierOnly(e: KeyboardEvent): boolean {
  return MODIFIER_KEYS.has(e.key);
}

/** Combinación ("Mod-Shift-p") que representa un evento de teclado. */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(eventKeyName(e));
  return parts.join("-");
}

function parseCombo(combo: string): { mods: Set<string>; key: string } {
  const parts = combo.split("-");
  let key = parts.pop() ?? "";
  // "Mod--" (tecla "-") deja un elemento vacío al final.
  if (key === "" && combo.endsWith("-")) {
    key = "-";
    parts.pop();
  }
  return { mods: new Set(parts), key };
}

/** ¿El evento corresponde a una combinación (un solo paso)? */
export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const { mods, key } = parseCombo(combo);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mods.has("Mod") !== mod) return false;
  if (mods.has("Shift") !== e.shiftKey) return false;
  if (mods.has("Alt") !== e.altKey) return false;
  return eventKeyName(e).toLowerCase() === key.toLowerCase();
}

const KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "Enter",
  Escape: "Esc",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/** Texto legible de una combinación o secuencia: "Ctrl+Shift+P", "Ctrl+Space ←". */
export function formatShortcut(shortcut: string): string {
  return shortcut
    .split(" ")
    .map((step) => {
      const { mods, key } = parseCombo(step);
      const out: string[] = [];
      if (mods.has("Mod")) out.push(isMac ? "⌘" : "Ctrl");
      if (mods.has("Alt")) out.push(isMac ? "⌥" : "Alt");
      if (mods.has("Shift")) out.push(isMac ? "⇧" : "Shift");
      out.push(KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key));
      return out.join(isMac ? "" : "+");
    })
    .join(" ");
}
