import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar from "./components/layout/Sidebar";
import ConnectionManager from "./components/connections/ConnectionManager";
import WorkspaceView from "./components/workspace/WorkspaceView";
import FavoritesView from "./components/favorites/FavoritesView";
import HistoryView from "./components/history/HistoryView";
import { useConnections } from "./stores/connectionsStore";
import { useSettings } from "./stores/settingsStore";
import { useWorkspaces } from "./stores/workspaceStore";
import type { QueryEvent } from "./ipc/types";
import { useShortcuts } from "./lib/shortcuts";

export default function App() {
  const load = useConnections((s) => s.load);
  const { workspaces, active } = useWorkspaces();

  useEffect(() => {
    void load();
    void useSettings.getState().load();
    const unlisten = listen<QueryEvent>("query:event", (event) => {
      useWorkspaces.getState().applyQueryEvent(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [load]);

  const workspace = typeof active === "string" ? workspaces[active] : undefined;

  /** Workspace anterior/siguiente en el orden del rail (circular). */
  const cycleWorkspace = (delta: number) => {
    const { order, active: cur, setActive } = useWorkspaces.getState();
    if (order.length === 0) return;
    const idx = order.indexOf(cur);
    const next = idx === -1 ? (delta > 0 ? 0 : order.length - 1) : (idx + delta + order.length) % order.length;
    setActive(order[next]);
  };
  const settings = useSettings.getState;

  // Atajos globales de TablePlus (ActionService.class_init, TablePlus Linux 0.1.316).
  useShortcuts([
    { keys: ["Mod-n", "Mod-Shift-n"], run: () => useWorkspaces.getState().setActive("home") },
    { keys: ["Mod-Shift-]", "Mod-Shift-}"], run: () => cycleWorkspace(1) },
    { keys: ["Mod-Shift-[", "Mod-Shift-{"], run: () => cycleWorkspace(-1) },
    { keys: ["Mod-=", "Mod-+", "Mod-Shift-+"], run: () => settings().bumpEditorFontSize(1) },
    { keys: ["Mod--"], run: () => settings().bumpEditorFontSize(-1) },
    { keys: ["Mod-0"], run: () => settings().resetEditorFontSize() },
    { keys: ["Mod-q"], run: () => void getCurrentWindow().close() },
    // Evita que el webview recargue la página si no hay workspace activo.
    { keys: ["Mod-r", "Mod-Shift-r", "F5"], run: () => {}, enabled: !workspace },
  ]);

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="workspace">
        {active === "home" && <ConnectionManager />}
        {active === "favorites" && <FavoritesView />}
        {active === "history" && <HistoryView />}
        {workspace && <WorkspaceView key={workspace.id} workspace={workspace} />}
      </main>
    </div>
  );
}
