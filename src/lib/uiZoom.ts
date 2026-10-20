import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { uiZoomFor, useSettings } from "../stores/settingsStore";

/**
 * Tamaño de la interfaz por pantalla: cada pantalla recuerda el zoom que el
 * usuario eligió para ella (por nombre); sin elección, 100 %.
 */
export function useApplyUiZoom() {
  const zoom = useSettings(uiZoomFor);

  // Sigue en qué pantalla está la ventana. En Wayland no llegan eventos de
  // movimiento: también se mira al recibir el foco o cambiar de tamaño.
  useEffect(() => {
    const win = getCurrentWindow();
    const check = () =>
      void currentMonitor()
        .then((m) => useSettings.getState().setMonitor(m?.name ?? null))
        .catch(() => {});
    check();
    const unlisten = [win.onMoved(check), win.onResized(check), win.onScaleChanged(check), win.onFocusChanged(check)];
    return () => unlisten.forEach((u) => void u.then((fn) => fn()));
  }, []);

  useEffect(() => {
    void getCurrentWebview().setZoom(zoom).catch(() => {});
  }, [zoom]);
}
