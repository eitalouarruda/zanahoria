import { useCallback, useState } from "react";
import { useConnections } from "../../stores/connectionsStore";
import { useWorkspaces } from "../../stores/workspaceStore";
import ContextMenu from "./ContextMenu";

const ENGINE_ICONS: Record<string, string> = {
  postgres: "🐘",
  mysql: "🐬",
  mariadb: "🦭",
  sqlite: "🪶",
  redis: "♦️",
};

/** Rail vertical: home + workspaces abiertos + vistas globales. */
export default function Sidebar() {
  const { saved } = useConnections();
  const { workspaces, order, active, setActive, closeWorkspace } = useWorkspaces();
  const [menu, setMenu] = useState<{ wsId: string; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <aside className="sidebar">
      <button
        className={`rail-btn ${active === "home" ? "active" : ""}`}
        title="Conexiones"
        onClick={() => setActive("home")}
      >
        🥕
      </button>
      <div className="rail-sep" />
      {order.map((wsId) => {
        const ws = workspaces[wsId];
        const conn = saved.find((c) => c.id === ws?.connId);
        const label = ws?.database || conn?.name || "";
        return (
          <button
            key={wsId}
            className={`rail-conn ${active === wsId ? "active" : ""}`}
            title={`${conn?.name ?? ws?.connId}${ws?.database ? ` / ${ws.database}` : ""}\n(click derecho: opciones)`}
            onClick={() => setActive(wsId)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ wsId, x: e.clientX, y: e.clientY });
            }}
          >
            <span
              className="rail-conn-icon"
              style={conn?.color ? { borderColor: conn.color } : undefined}
            >
              {ENGINE_ICONS[conn?.engine ?? ""] ?? "🗄"}
            </span>
            <span className="rail-conn-label">{label}</span>
          </button>
        );
      })}
      <div className="rail-spacer" />
      <button
        className={`rail-btn ${active === "favorites" ? "active" : ""}`}
        title="Queries favoritas (todas las conexiones)"
        onClick={() => setActive("favorites")}
      >
        ★
      </button>
      <button
        className={`rail-btn ${active === "history" ? "active" : ""}`}
        title="Historial de queries"
        onClick={() => setActive("history")}
      >
        🕘
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            {
              label: "Cerrar",
              danger: true,
              onSelect: () => closeWorkspace(menu.wsId),
            },
            {
              label: "Cerrar las demás",
              disabled: order.length < 2,
              onSelect: () =>
                order.filter((id) => id !== menu.wsId).forEach((id) => closeWorkspace(id)),
            },
          ]}
        />
      )}
    </aside>
  );
}
