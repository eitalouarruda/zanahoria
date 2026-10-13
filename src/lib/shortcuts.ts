import { useEffect, useRef } from "react";

/**
 * Atajo en formato "Mod-Shift-Alt-<tecla>" (Mod = Ctrl, o Cmd en macOS).
 * La tecla se compara con `KeyboardEvent.key` sin distinguir mayúsculas.
 */
export type Shortcut = string;

export interface Binding {
  keys: Shortcut[];
  run: () => void;
  /** Si es false el atajo se ignora (por ejemplo, sin cambios pendientes). */
  enabled?: boolean;
}

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

function matches(e: KeyboardEvent, shortcut: Shortcut): boolean {
  const parts = shortcut.split("-");
  // "Mod--" (tecla "-") deja un elemento vacío al final.
  let key = parts.pop() ?? "";
  if (key === "" && shortcut.endsWith("-")) key = "-";
  const mods = new Set(parts);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mods.has("Mod") !== mod) return false;
  if (mods.has("Shift") !== e.shiftKey) return false;
  if (mods.has("Alt") !== e.altKey) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

/**
 * Registra atajos de teclado a nivel de ventana, en fase de captura para que
 * tengan prioridad sobre los keymaps de CodeMirror. Los handlers se leen de
 * un ref, así que pueden cerrar sobre el estado actual sin re-registrar.
 */
export function useShortcuts(bindings: Binding[], active = true) {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      for (const b of ref.current) {
        if (b.enabled === false) continue;
        if (b.keys.some((k) => matches(e, k))) {
          e.preventDefault();
          e.stopImmediatePropagation();
          b.run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);
}
