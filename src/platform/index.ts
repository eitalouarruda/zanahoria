import { getCurrentWindow as nativeWindow, currentMonitor as nativeMonitor } from "@tauri-apps/api/window";
import { getCurrentWebview as nativeWebview } from "@tauri-apps/api/webview";
import type { OpenDialogOptions, SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import * as web from "./web";
export const isWeb = import.meta.env.MODE === "web";
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return isWeb ? web.invoke<T>(command, args) : (await import("@tauri-apps/api/core")).invoke<T>(command, args);
}
export async function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  return isWeb ? web.listen(event, handler) : (await import("@tauri-apps/api/event")).listen<T>(event, handler);
}
export async function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  return isWeb ? web.pickFile() : (await import("@tauri-apps/plugin-dialog")).open(options);
}
export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
  return isWeb ? web.saveFile(options.defaultPath ?? "export.txt") : (await import("@tauri-apps/plugin-dialog")).save(options);
}
export async function writeText(text: string): Promise<void> {
  if (isWeb) return navigator.clipboard.writeText(text);
  return (await import("@tauri-apps/plugin-clipboard-manager")).writeText(text);
}
export async function getVersion(): Promise<string> {
  return isWeb ? "web" : (await import("@tauri-apps/api/app")).getVersion();
}
function browserEvent(event: string, callback: () => void): Promise<() => void> {
  window.addEventListener(event, callback); return Promise.resolve(() => window.removeEventListener(event, callback));
}
export function getCurrentWindow() {
  if (!isWeb) return nativeWindow();
  return { close: async () => { window.top!.location.href = "/"; }, onMoved: (cb: () => void) => browserEvent("resize", cb), onResized: (cb: () => void) => browserEvent("resize", cb), onScaleChanged: (cb: () => void) => browserEvent("resize", cb), onFocusChanged: (cb: () => void) => browserEvent("focus", cb) };
}
export async function currentMonitor() { return isWeb ? { name: "browser" } : nativeMonitor(); }
export function getCurrentWebview() { return isWeb ? { setZoom: async (zoom: number) => { document.body.style.setProperty("zoom", String(zoom)); } } : nativeWebview(); }
