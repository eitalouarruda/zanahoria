import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar from "./components/layout/Sidebar";
import ConnectionManager from "./components/connections/ConnectionManager";
import WorkspaceView from "./components/workspace/WorkspaceView";
import FavoritesView from "./components/favorites/FavoritesView";
import HistoryView from "./components/history/HistoryView";
import SettingsView from "./components/settings/SettingsView";
import BackupView from "./components/backup/BackupView";
import UpdateDialog from "./components/update/UpdateDialog";
import { useConnections } from "./stores/connectionsStore";
import { useSettings } from "./stores/settingsStore";
import { useWorkspaces } from "./stores/workspaceStore";
import type { QueryEvent } from "./ipc/types";
import { useShortcuts } from "./lib/shortcuts";
import { useApplyTheme } from "./lib/theme";
import { useApplyUiZoom } from "./lib/uiZoom";

export default function App() {
  const load = useConnections((s) => s.load);
  const { workspaces, active } = useWorkspaces();
  useApplyTheme();
  useApplyUiZoom();

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

  // Atajos globales (configurables en Settings → Keyboard shortcuts).
  useShortcuts([
    { action: "newConnection", run: () => useWorkspaces.getState().setActive("home") },
    { action: "nextWorkspace", run: () => cycleWorkspace(1) },
    { action: "prevWorkspace", run: () => cycleWorkspace(-1) },
    { action: "openSettings", run: () => useWorkspaces.getState().setActive("settings") },
    { action: "zoomIn", run: () => settings().bumpEditorFontSize(1) },
    { action: "zoomOut", run: () => settings().bumpEditorFontSize(-1) },
    { action: "zoomReset", run: () => settings().resetEditorFontSize() },
    { action: "uiZoomIn", run: () => settings().changeUiZoom(1) },
    { action: "uiZoomOut", run: () => settings().changeUiZoom(-1) },
    { action: "uiZoomReset", run: () => settings().changeUiZoom(0) },
    { action: "quit", run: () => void getCurrentWindow().close() },
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
        {/* Montado siempre: un backup/restore en curso sigue al cambiar de vista. */}
        <div className="view-slot" hidden={active !== "backup"}>
          <BackupView />
        </div>
        {active === "settings" && <SettingsView />}
        {workspace && <WorkspaceView key={workspace.id} workspace={workspace} />}
      </main>
      <UpdateDialog />
    </div>
  );
}
