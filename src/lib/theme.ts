import { useEffect, useState } from "react";
import { useSettings } from "../stores/settingsStore";

export type ResolvedTheme = "dark" | "light";

const media = () =>
  typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: light)") : null;

/** Tema efectivo: el elegido en Settings, o el del sistema si es "system". */
export function useResolvedTheme(): ResolvedTheme {
  const setting = useSettings((s) => s.theme);
  const [systemLight, setSystemLight] = useState(() => media()?.matches ?? false);

  useEffect(() => {
    const m = media();
    if (!m) return;
    const onChange = () => setSystemLight(m.matches);
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);

  if (setting === "system") return systemLight ? "light" : "dark";
  return setting;
}

/** Aplica el tema al documento (variables CSS en `:root[data-theme]`). */
export function useApplyTheme() {
  const theme = useResolvedTheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
}
