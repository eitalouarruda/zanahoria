import { useRef, useState, type KeyboardEvent } from "react";
import { useConnections, groupNames, normalizeGroup } from "../../stores/connectionsStore";
import { useWorkspaces } from "../../stores/workspaceStore";
import { ipc, errorMessage } from "../../ipc/commands";
import type { ConnectionConfig, SavedConnection } from "../../ipc/types";
import ConnectionForm from "./ConnectionForm";
import { useT } from "../../i18n";

const ENGINE_ICONS: Record<string, string> = {
  postgres: "🐘",
  mysql: "🐬",
  mariadb: "🦭",
  sqlite: "🪶",
  redis: "♦️",
};

export default function ConnectionManager() {
  const t = useT();
  const {
    saved,
    statuses,
    errors,
    emptyGroups,
    collapsedGroups,
    save,
    remove,
    connect,
    createGroup,
    renameGroup,
    deleteGroup,
    toggleGroupCollapsed,
  } = useConnections();
  const { openWorkspace } = useWorkspaces();
  const [editing, setEditing] = useState<
    { config: ConnectionConfig | null; group: string | null } | null
  >(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Input inline para crear (key "") o renombrar (key = nombre actual) un grupo.
  const [groupDraft, setGroupDraft] = useState<{ from: string; value: string } | null>(null);
  // Enter/Escape desmontan el input y disparan un blur con el closure viejo;
  // el ref evita que ese blur vuelva a aplicar (o aplique tras Escape) el draft.
  const draftRef = useRef(groupDraft);
  draftRef.current = groupDraft;

  const groups = groupNames(saved, emptyGroups);
  const ungrouped = saved.filter((c) => !normalizeGroup(c.group));

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

  const commitGroupDraft = async () => {
    const draft = draftRef.current;
    if (!draft) return;
    draftRef.current = null;
    setGroupDraft(null);
    const { from, value } = draft;
    try {
      if (from === "") createGroup(value);
      else await renameGroup(from, value);
    } catch (e) {
      setFailure(errorMessage(e));
    }
  };

  const onDraftKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void commitGroupDraft();
    if (e.key === "Escape") {
      draftRef.current = null;
      setGroupDraft(null);
    }
  };

  const draftInput = (
    <input
      className="group-name-input"
      autoFocus
      value={groupDraft?.value ?? ""}
      placeholder={t("conn.groupNamePlaceholder")}
      onChange={(e) => setGroupDraft((d) => d && { ...d, value: e.target.value })}
      onKeyDown={onDraftKey}
      onBlur={() => void commitGroupDraft()}
    />
  );

  if (editing !== null) {
    return (
      <div className="connection-manager">
        <ConnectionForm
          initial={editing.config}
          defaultGroup={editing.group}
          groups={groups}
          onSave={async (config) => {
            await save(config);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  const renderCard = (conn: SavedConnection) => (
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
      {conn.safeMode ? (
        <span className="safe-badge">{t("safe.on")}</span>
      ) : (
        <span className="safe-badge off">{t("safe.off")}</span>
      )}
      {/* Estado solo cuando aporta algo (conectado / conectando / error). */}
      {statuses[conn.id] && statuses[conn.id] !== "disconnected" && (
        <span
          className={`status-dot ${statuses[conn.id]}`}
          title={t(`conn.status.${statuses[conn.id] as "connected" | "connecting" | "error"}`)}
        />
      )}
      <div className="conn-actions">
        <button
          className="primary"
          disabled={statuses[conn.id] === "connecting"}
          onClick={() => void openConnection(conn)}
        >
          {statuses[conn.id] === "connecting" ? t("conn.connecting") : t("conn.connect")}
        </button>
        <button
          onClick={() => setEditing({ config: { ...conn, password: "" }, group: null })}
        >
          {t("common.edit")}
        </button>
        <button
          className="danger"
          onClick={() => {
            if (window.confirm(t("conn.confirmDelete", { name: conn.name }))) {
              void remove(conn.id);
            }
          }}
        >
          {t("common.delete")}
        </button>
      </div>
    </div>
  );

  return (
    <div className="connection-manager">
      <div className="cm-header">
        <h2>{t("conn.title")}</h2>
        <button onClick={() => setGroupDraft({ from: "", value: "" })}>
          {t("conn.newGroup")}
        </button>
        <button className="primary" onClick={() => setEditing({ config: null, group: null })}>
          {t("conn.new")}
        </button>
      </div>
      {failure && <div className="error-banner">{failure}</div>}
      {saved.length === 0 && groups.length === 0 && groupDraft?.from !== "" && (
        <p className="dim">{t("conn.empty")}</p>
      )}
      <div className="connection-list">
        {groupDraft?.from === "" && <div className="group-header">{draftInput}</div>}
        {groups.map((group) => {
          const members = saved.filter((c) => normalizeGroup(c.group) === group);
          const collapsed = collapsedGroups.includes(group);
          return (
            <section key={group} className="connection-group">
              <div className="group-header">
                {groupDraft?.from === group ? (
                  draftInput
                ) : (
                  <button
                    className="group-toggle"
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroupCollapsed(group)}
                  >
                    <span className="group-caret">{collapsed ? "▸" : "▾"}</span>
                    <span className="group-name">{group}</span>
                    <span className="group-count">{members.length}</span>
                  </button>
                )}
                <div className="group-actions">
                  <button
                    title={t("conn.newInGroup")}
                    onClick={() => setEditing({ config: null, group })}
                  >
                    +
                  </button>
                  <button onClick={() => setGroupDraft({ from: group, value: group })}>
                    {t("conn.renameGroup")}
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      if (window.confirm(t("conn.confirmDeleteGroup", { name: group }))) {
                        void deleteGroup(group).catch((e) => setFailure(errorMessage(e)));
                      }
                    }}
                  >
                    {t("conn.deleteGroup")}
                  </button>
                </div>
              </div>
              {!collapsed && (
                <div className="group-body">
                  {members.length === 0 ? (
                    <p className="dim group-empty">{t("conn.groupEmpty")}</p>
                  ) : (
                    members.map(renderCard)
                  )}
                </div>
              )}
            </section>
          );
        })}
        {groups.length > 0 && ungrouped.length > 0 && (
          <div className="group-header ungrouped">
            <span className="group-name">{t("conn.ungrouped")}</span>
          </div>
        )}
        {ungrouped.map(renderCard)}
      </div>
    </div>
  );
}
