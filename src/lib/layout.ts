import { useEffect, useSyncExternalStore } from "react";

/**
 * Layout de teléfono: pantalla angosta y puntero táctil. Exigir `coarse`
 * deja intacto el desktop aunque la ventana sea chica o haya zoom de UI.
 */
const MOBILE_QUERY = "(max-width: 767px) and (pointer: coarse)";

function mediaQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia(MOBILE_QUERY)
    : null;
}

function subscribe(onChange: () => void) {
  const mq = mediaQuery();
  mq?.addEventListener("change", onChange);
  return () => mq?.removeEventListener("change", onChange);
}

export function useIsMobileLayout(): boolean {
  return useSyncExternalStore(subscribe, () => mediaQuery()?.matches ?? false);
}

/** Marca `<html data-layout="mobile">` para que el CSS móvil aplique. */
export function useApplyLayout(): boolean {
  const mobile = useIsMobileLayout();
  useEffect(() => {
    const root = document.documentElement;
    if (mobile) root.dataset.layout = "mobile";
    else delete root.dataset.layout;
  }, [mobile]);
  return mobile;
}
