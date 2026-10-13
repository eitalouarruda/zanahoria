import { useCallback } from "react";
import { useSettings, type Language } from "../stores/settingsStore";
import { en, type MessageKey } from "./en";
import { es } from "./es";
import { pt } from "./pt";

export type { MessageKey };

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { en, es, pt };

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "pt", label: "Português" },
  { value: "es", label: "Español" },
];

export type TranslateVars = Record<string, string | number>;

/** Traduce `key` al idioma dado, reemplazando `{var}`. */
export function translate(language: Language, key: MessageKey, vars?: TranslateVars): string {
  let text = DICTIONARIES[language]?.[key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  }
  return text;
}

/** Hook: función `t` del idioma actual (re-renderiza al cambiar el idioma). */
export function useT() {
  const language = useSettings((s) => s.language);
  return useCallback(
    (key: MessageKey, vars?: TranslateVars) => translate(language, key, vars),
    [language],
  );
}
