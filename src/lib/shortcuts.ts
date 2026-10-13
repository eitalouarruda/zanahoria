import { useEffect, useRef, type MutableRefObject } from "react";
import { useSettings } from "../stores/settingsStore";
import {
  formatShortcut,
  isModifierOnly,
  keysFor,
  matchesCombo,
  type ActionId,
} from "./keymap";

export interface Binding {
  action: ActionId;
  run: () => void;
  /** Si es false el atajo se ignora (por ejemplo, sin cambios pendientes). */
  enabled?: boolean;
}

/** Atajos fijos que no se configuran (cerrar diálogos con Esc). */
export interface RawBinding {
  keys: string[];
  run: () => void;
  enabled?: boolean;
}

type AnyBinding = Binding | RawBinding;

/** Grupos de atajos montados (App, workspace activo…), en orden de registro. */
const groups = new Set<MutableRefObject<AnyBinding[]>>();

/** Primer paso de una secuencia ya pulsado (p. ej. Ctrl+Space). */
let pendingPrefix: { combo: string; expires: number } | null = null;
/** true mientras Settings graba un atajo nuevo: ninguno se dispara. */
let suspended = false;
const CHORD_TIMEOUT_MS = 1500;

/** Teclas efectivas de cada binding activo, con las redefiniciones del usuario. */
function activeBindings() {
  const overrides = useSettings.getState().shortcuts;
  const out: { run: () => void; keys: string[] }[] = [];
  for (const group of groups) {
    for (const b of group.current) {
      if (b.enabled === false) continue;
      out.push({ run: b.run, keys: "action" in b ? keysFor(b.action, overrides) : b.keys });
    }
  }
  return out;
}

function onKeyDown(e: KeyboardEvent) {
  if (suspended || isModifierOnly(e)) return;
  const consume = (run?: () => void) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    run?.();
  };
  const bindings = activeBindings();

  // Segundo paso de una secuencia: corre la acción o se cancela.
  if (pendingPrefix) {
    const { combo, expires } = pendingPrefix;
    pendingPrefix = null;
    if (Date.now() < expires) {
      for (const { run, keys } of bindings) {
        for (const k of keys) {
          const [first, second] = k.split(" ");
          if (second && first === combo && matchesCombo(e, second)) return consume(run);
        }
      }
      // Tecla que no completa ninguna secuencia: se descarta (como tmux).
      return consume();
    }
  }

  for (const { run, keys } of bindings) {
    for (const k of keys) {
      const steps = k.split(" ");
      if (!matchesCombo(e, steps[0])) continue;
      if (steps.length === 1) return consume(run);
      pendingPrefix = { combo: steps[0], expires: Date.now() + CHORD_TIMEOUT_MS };
      return consume();
    }
  }
}

/**
 * Registra atajos mientras el componente está montado. Un único listener de
 * ventana (fase de captura, con prioridad sobre CodeMirror) atiende a todos
 * los grupos. Los handlers se leen de un ref: pueden cerrar sobre el estado
 * actual sin re-registrar.
 */
export function useShortcuts(bindings: AnyBinding[], active = true) {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    if (!active) return;
    if (groups.size === 0) window.addEventListener("keydown", onKeyDown, true);
    groups.add(ref);
    return () => {
      groups.delete(ref);
      if (groups.size === 0) window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active]);
}

/** Suspende todos los atajos (p. ej. mientras se graba uno nuevo en Settings). */
export function setShortcutsSuspended(value: boolean) {
  suspended = value;
  pendingPrefix = null;
}

/** Texto del primer atajo de una acción ("Ctrl+K"), o "" si no tiene. */
export function useShortcutLabel(action: ActionId): string {
  const overrides = useSettings((s) => s.shortcuts);
  const keys = keysFor(action, overrides);
  return keys.length > 0 ? formatShortcut(keys[0]) : "";
}
