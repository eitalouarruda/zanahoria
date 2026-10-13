import { create } from "zustand";
import { ipc } from "../ipc/commands";
import type { ActionId } from "../lib/keymap";

const MIN_FONT = 9;
const MAX_FONT = 28;

export type Language = "en" | "pt" | "es";
export type ThemeSetting = "dark" | "light" | "system";

interface SettingsState {
  editorFontSize: number;
  language: Language;
  theme: ThemeSetting;
  /** Atajos redefinidos por el usuario (los demás usan el default). */
  shortcuts: Partial<Record<ActionId, string[]>>;

  load: () => Promise<void>;
  setEditorFontSize: (size: number) => void;
  bumpEditorFontSize: (delta: number) => void;
  resetEditorFontSize: () => void;
  setLanguage: (language: Language) => void;
  setTheme: (theme: ThemeSetting) => void;
  setShortcut: (action: ActionId, keys: string[]) => void;
  resetShortcut: (action: ActionId) => void;
  resetAllShortcuts: () => void;
}

const persist = (key: string, value: unknown) => void ipc.kvSet("settings", key, value);

export const useSettings = create<SettingsState>((set, get) => ({
  editorFontSize: 13,
  language: "en",
  theme: "dark",
  shortcuts: {},

  load: async () => {
    const read = async <T>(key: string): Promise<T | null> => {
      try {
        return await ipc.kvGet<T>("settings", key);
      } catch {
        return null;
      }
    };
    const [size, language, theme, shortcuts] = await Promise.all([
      read<number>("editor_font_size"),
      read<Language>("language"),
      read<ThemeSetting>("theme"),
      read<Partial<Record<ActionId, string[]>>>("shortcuts"),
    ]);
    set({
      ...(typeof size === "number" ? { editorFontSize: size } : {}),
      ...(language === "en" || language === "pt" || language === "es" ? { language } : {}),
      ...(theme === "dark" || theme === "light" || theme === "system" ? { theme } : {}),
      ...(shortcuts && typeof shortcuts === "object" ? { shortcuts } : {}),
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
}));
