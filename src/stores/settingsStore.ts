import { create } from "zustand";
import { ipc } from "../ipc/commands";

const MIN_FONT = 9;
const MAX_FONT = 28;

interface SettingsState {
  editorFontSize: number;
  load: () => Promise<void>;
  setEditorFontSize: (size: number) => void;
  bumpEditorFontSize: (delta: number) => void;
  resetEditorFontSize: () => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  editorFontSize: 13,

  load: async () => {
    try {
      const size = await ipc.kvGet<number>("settings", "editor_font_size");
      if (typeof size === "number") set({ editorFontSize: size });
    } catch {
      // defaults
    }
  },

  setEditorFontSize: (size) => {
    const clamped = Math.min(MAX_FONT, Math.max(MIN_FONT, size));
    set({ editorFontSize: clamped });
    void ipc.kvSet("settings", "editor_font_size", clamped);
  },

  bumpEditorFontSize: (delta) => {
    get().setEditorFontSize(get().editorFontSize + delta);
  },

  resetEditorFontSize: () => {
    get().setEditorFontSize(13);
  },
}));
