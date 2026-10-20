import { create } from "zustand";
import { ipc } from "../ipc/commands";
import type { ActionId } from "../lib/keymap";

const MIN_FONT = 9;
const MAX_FONT = 28;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

/** Pasos de 5 %: evita acumular errores al sumar 0,1 muchas veces. */
const clampZoom = (zoom: number) =>
  Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 20) / 20;

export type Language = "en" | "pt" | "es";
export type ThemeSetting = "dark" | "light" | "system";

interface SettingsState {
  editorFontSize: number;
  language: Language;
  theme: ThemeSetting;
  /** Atajos redefinidos por el usuario (los demás usan el default). */
  shortcuts: Partial<Record<ActionId, string[]>>;
  /** Tamaño de la interfaz elegido por el usuario, por nombre de pantalla. */
  uiZoom: Record<string, number>;
  /** Pantalla donde está la ventana (null: no se sabe, p. ej. en Android). */
  monitor: string | null;

  load: () => Promise<void>;
  setEditorFontSize: (size: number) => void;
  bumpEditorFontSize: (delta: number) => void;
  resetEditorFontSize: () => void;
  setLanguage: (language: Language) => void;
  setTheme: (theme: ThemeSetting) => void;
  setShortcut: (action: ActionId, keys: string[]) => void;
  resetShortcut: (action: ActionId) => void;
  resetAllShortcuts: () => void;
  setMonitor: (monitor: string | null) => void;
  /** ±1 agranda o achica un 10 % en esta pantalla; 0 vuelve al automático. */
  changeUiZoom: (step: number) => void;
}

/** Zoom de la interfaz en `monitor`: el elegido, o 100 % (automático). */
export const uiZoomFor = (s: Pick<SettingsState, "uiZoom" | "monitor">) =>
  (s.monitor !== null && s.uiZoom[s.monitor]) || 1;

const persist = (key: string, value: unknown) => void ipc.kvSet("settings", key, value);

export const useSettings = create<SettingsState>((set, get) => ({
  editorFontSize: 13,
  language: "en",
  theme: "dark",
  shortcuts: {},
  uiZoom: {},
  monitor: null,

  load: async () => {
    const read = async <T>(key: string): Promise<T | null> => {
      try {
        return await ipc.kvGet<T>("settings", key);
      } catch {
        return null;
      }
    };
    const [size, language, theme, shortcuts, uiZoom] = await Promise.all([
      read<number>("editor_font_size"),
      read<Language>("language"),
      read<ThemeSetting>("theme"),
      read<Partial<Record<ActionId, string[]>>>("shortcuts"),
      read<Record<string, number>>("ui_zoom"),
    ]);
    set({
      ...(typeof size === "number" ? { editorFontSize: size } : {}),
      ...(language === "en" || language === "pt" || language === "es" ? { language } : {}),
      ...(theme === "dark" || theme === "light" || theme === "system" ? { theme } : {}),
      ...(shortcuts && typeof shortcuts === "object" ? { shortcuts } : {}),
      ...(uiZoom && typeof uiZoom === "object" ? { uiZoom } : {}),
    });
  },

  setEditorFontSize: (size) => {
    const clamped = Math.min(MAX_FONT, Math.max(MIN_FONT, size));
    set({ editorFontSize: clamped });
    persist("editor_font_size", clamped);
  },

  bumpEditorFontSize: (delta) => {
    get().setEditorFontSize(get().editorFontSize + delta);
  },

  resetEditorFontSize: () => {
    get().setEditorFontSize(13);
  },

  setLanguage: (language) => {
    set({ language });
    persist("language", language);
  },

  setTheme: (theme) => {
    set({ theme });
    persist("theme", theme);
  },

  setShortcut: (action, keys) => {
    const shortcuts = { ...get().shortcuts, [action]: keys };
    set({ shortcuts });
    persist("shortcuts", shortcuts);
  },

  resetShortcut: (action) => {
    const { [action]: _, ...shortcuts } = get().shortcuts;
    set({ shortcuts });
    persist("shortcuts", shortcuts);
  },

  resetAllShortcuts: () => {
    set({ shortcuts: {} });
    persist("shortcuts", {});
  },

  setMonitor: (monitor) => {
    if (monitor !== get().monitor) set({ monitor });
  },

  changeUiZoom: (step) => {
    const { monitor } = get();
    if (monitor === null) return;
    const { [monitor]: _, ...uiZoom } = get().uiZoom;
    if (step !== 0) uiZoom[monitor] = clampZoom(uiZoomFor(get()) + 0.1 * step);
    set({ uiZoom });
    persist("ui_zoom", uiZoom);
  },
}));
