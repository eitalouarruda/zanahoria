import { useState } from "react";
import { useConnections } from "../../stores/connectionsStore";
import { useWorkspaces } from "../../stores/workspaceStore";
import { ipc, errorMessage } from "../../ipc/commands";
import type { ConnectionConfig, SavedConnection } from "../../ipc/types";
import ConnectionForm from "./ConnectionForm";

const ENGINE_ICONS: Record<string, string> = {
  postgres: "🐘",
  mysql: "🐬",
  mariadb: "🦭",
  sqlite: "🪶",
  redis: "♦️",
};

export default function ConnectionManager() {
  const { saved, statuses, errors, save, remove, connect } = useConnections();
  const { openWorkspace } = useWorkspaces();
  const [editing, setEditing] = useState<ConnectionConfig | null | "new">(null);
  const [failure, setFailure] = useState<string | null>(null);

  const openConnection = async (conn: SavedConnection) => {
    setFailure(null);
    try {
      const info = await connect(conn.id);
      const database =
        conn.database || info.databases[0] || (conn.engine === "redis" ? "0" : "");
      // El pool quedó conectado a la database de la config; si el workspace
      // va a mostrar otra, reconectar alineado para que las queries corran
      // contra la misma database que muestra el schema.
      if (database !== conn.database) {
        await ipc.connect(conn.id, database);
      }
      openWorkspace(conn.id, database);
    } catch (e) {
      setFailure(errorMessage(e));
    }
  };

  if (editing !== null) {
    return (
      <div className="connection-manager">
        <ConnectionForm
          initial={editing === "new" ? null : editing}
          onSave={async (config) => {
            await save(config);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div className="connection-manager">
      <div className="cm-header">
        <h2>Conexiones</h2>
        <button className="primary" onClick={() => setEditing("new")}>
          + Nueva conexión
        </button>
      </div>
      {failure && <div className="error-banner">{failure}</div>}
      {saved.length === 0 && (
        <p className="dim">No hay conexiones guardadas todavía.</p>
      )}
      <div className="connection-list">
        {saved.map((conn) => (
          <div
            key={conn.id}
            className="connection-card"
            onDoubleClick={() => void openConnection(conn)}
          >
            <span className="engine-icon">{ENGINE_ICONS[conn.engine]}</span>
            <div className="conn-details">
              <strong>{conn.name}</strong>
              <span className="dim">
                {conn.engine === "sqlite"
                  ? conn.database
                  : `${conn.user}@${conn.host}:${conn.port ?? ""}/${conn.database}`}
              </span>
              {errors[conn.id] && statuses[conn.id] === "error" && (
                <span className="test-fail">{errors[conn.id]}</span>
              )}
            </div>
            {conn.safeMode && <span className="safe-badge">SAFE</span>}
            <span className={`status-dot ${statuses[conn.id] ?? "disconnected"}`} />
            <div className="conn-actions">
              <button
                className="primary"
                disabled={statuses[conn.id] === "connecting"}
                onClick={() => void openConnection(conn)}
              >
                {statuses[conn.id] === "connecting" ? "Conectando…" : "Conectar"}
              </button>
              <button
                onClick={() => setEditing({ ...conn, password: "" })}
              >
                Editar
              </button>
              <button
                className="danger"
                onClick={() => {
                  if (window.confirm(`¿Eliminar la conexión "${conn.name}"?`)) {
                    void remove(conn.id);
                  }
                }}
              >
                Eliminar
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
