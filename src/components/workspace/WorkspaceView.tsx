import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useConnections } from "../../stores/connectionsStore";
import { useWorkspaces, type Workspace } from "../../stores/workspaceStore";
import { ipc, errorMessage } from "../../ipc/commands";
import type { Engine, FavoriteQuery, MutationPreview } from "../../ipc/types";
import { beautify, uglify } from "../../lib/format";
import { useShortcuts } from "../../lib/shortcuts";
import { exportResult, type ExportFormat } from "../../lib/export";
import SqlEditor, { type EditorApi } from "../editor/SqlEditor";
import ResultsGrid from "../grid/ResultsGrid";
import SchemaTree from "../schema/SchemaTree";
import CodePreviewModal from "../preview/CodePreviewModal";
import BackupModal from "../backup/BackupModal";
import DatabasePicker from "./DatabasePicker";

interface Props {
  workspace: Workspace;
}

export default function WorkspaceView({ workspace }: Props) {
  // wsId: clave del workspace en el store (conexión + database);
  // connId: id de la conexión para el backend.
  const wsId = workspace.id;
  const connId = workspace.connId;
  const { saved, infos } = useConnections();
  const ws = useWorkspaces();
  const config = saved.find((c) => c.id === connId);
  const info = infos[connId];
  const engine: Engine = config?.engine ?? "postgres";

  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId);
  const { database, schema, schemaError } = workspace;
  /** Otra database de la conexión: se abre como entrada propia en el rail. */
  const openDatabase = (db: string) => void ws.openWorkspace(connId, db);
  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [favName, setFavName] = useState<string | null>(null);
  const [showBackup, setShowBackup] = useState(false);
  const [backupSupported, setBackupSupported] = useState(false);
  const editorApi = useRef<EditorApi | null>(null);
  const [showDbPicker, setShowDbPicker] = useState(false);

  /** Ejecuta la selección del editor si la hay; si no, todo el texto. */
  const run = (tabId: string, confirmDangerous = false, selection?: string) => {
    const sel = selection ?? editorApi.current?.getSelection();
    void ws.runQuery(wsId, tabId, confirmDangerous, sel || undefined);
  };

  useEffect(() => {
    void ipc
      .getPlatformCapabilities()
      .then((caps) => setBackupSupported(caps.backupSupported))
      .catch(() => {});
  }, []);

  const pendingCount = tab
    ? Object.keys(tab.result.changes).length + tab.result.inserts.length
    : 0;

  /** Tab anterior/siguiente (circular). */
  const cycleTab = (delta: number) => {
    const tabs = workspace.tabs;
    const idx = tabs.findIndex((t) => t.id === workspace.activeTabId);
    if (tabs.length < 2 || idx === -1) return;
    ws.setActiveTab(wsId, tabs[(idx + delta + tabs.length) % tabs.length].id);
  };
  const modalOpen = preview !== null || favName !== null || showBackup || showDbPicker;

  // Atajos del workspace (mismos defaults que TablePlus).
  useShortcuts([
    { keys: ["Escape"], enabled: modalOpen, run: () => {
      setPreview(null);
      setFavName(null);
      setShowBackup(false);
      setShowDbPicker(false);
    } },
    { keys: ["Mod-t"], run: () => ws.addTab(wsId) },
    { keys: ["Mod-w"], enabled: !!tab, run: () => tab && ws.closeTab(wsId, tab.id) },
    { keys: ["Mod-]", "Mod-Tab", "Mod-PageDown"], run: () => cycleTab(1) },
    { keys: ["Mod-[", "Mod-Shift-Tab", "Mod-PageUp"], run: () => cycleTab(-1) },
    // Reload: repite la última query ejecutada del tab (o todo el editor).
    { keys: ["Mod-r", "F5"], enabled: !!tab && !tab.result.running, run: () =>
      tab && run(tab.id, false, tab.result.executedSql ?? tab.sql) },
    { keys: ["Mod-Shift-p"], enabled: pendingCount > 0, run: () => void showPreview() },
    // Commit: en Safe Mode siempre pasa por el preview.
    { keys: ["Mod-s"], enabled: pendingCount > 0 && !applying, run: () =>
      void (config?.safeMode ? showPreview() : commit()) },
    { keys: ["Mod-i"], enabled: !!tab && engine !== "redis", run: () =>
      tab && ws.setTabSql(wsId, tab.id, beautify(tab.sql, engine)) },
    { keys: ["Mod-Shift-i"], enabled: !!tab && engine !== "redis", run: () =>
      tab && ws.setTabSql(wsId, tab.id, uglify(tab.sql)) },
    { keys: ["Mod-k"], enabled: !!info?.capabilities.multipleDatabases, run: () =>
      setShowDbPicker(true) },
    // "Logout": cierra el workspace y desconecta.
    { keys: ["Mod-Escape"], run: () => {
      ws.closeWorkspace(wsId);
    } },
  ]);

  const browseTable = (namespace: string | null, table: string) => {
    const q = (id: string) =>
      engine === "mysql" || engine === "mariadb" ? `\`${id}\`` : `"${id}"`;
    const name = namespace ? `${q(namespace)}.${q(table)}` : q(table);
    ws.addTab(wsId, table, `SELECT * FROM ${name} LIMIT 500;`);
    // ejecutar cuando el tab exista
    setTimeout(() => {
      const current = useWorkspaces.getState().workspaces[wsId];
      if (current) void ws.runQuery(wsId, current.activeTabId);
    }, 0);
  };

  const showPreview = async () => {
    if (!tab?.result.editability) return;
    try {
      const changes = ws.pendingChanges(wsId, tab.id);
      if (changes.length === 0) return;
      setPreview(await ipc.previewMutations(connId, tab.result.editability, changes));
    } catch (e) {
      setNotice(errorMessage(e));
    }
  };

  const commit = async () => {
    if (!tab?.result.editability) return;
    setApplying(true);
    try {
      const changes = ws.pendingChanges(wsId, tab.id);
      const result = await ipc.applyMutations(
        connId,
        database,
        tab.result.editability,
        changes,
      );
      setPreview(null);
      ws.discardChanges(wsId, tab.id);
      setNotice(`✓ ${result.affectedTotal} fila(s) afectadas`);
      void ws.runQuery(wsId, tab.id);
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setApplying(false);
    }
  };

  const saveFavorite = async () => {
    if (!tab || !favName) return;
    const favorite: FavoriteQuery = {
      id: "",
      name: favName,
      sql: tab.sql,
      connId,
      database,
      tags: [],
      createdAt: 0,
    };
    await ipc.saveFavorite(favorite);
    setFavName(null);
    setNotice("✓ Favorita guardada");
  };

  const doExport = async (format: ExportFormat) => {
    if (!tab) return;
    const ok = await exportResult(
      format,
      tab.result.columns,
      tab.result.rows,
      tab.result.editability?.table ?? undefined,
    );
    if (ok) setNotice(`✓ Exportado como ${format.toUpperCase()}`);
  };

  if (!config) return null;

  return (
    <div className="workspace-view">
      <div className="workspace-header">
        <span className="conn-name" style={{ color: config.color ?? undefined }}>
          {config.name}
        </span>
        {config.safeMode && <span className="safe-badge">SAFE MODE</span>}
        {info?.capabilities.multipleDatabases && (
          <select
            title="Cambiar database (Ctrl+K)"
            value={database}
            onChange={(e) => openDatabase(e.target.value)}
          >
            {(info?.databases ?? [database]).map((db) => (
              <option key={db} value={db}>
                {db}
              </option>
            ))}
          </select>
        )}
        {(backupSupported || engine === "sqlite") &&
          info?.capabilities.backup && (
            <button onClick={() => setShowBackup(true)} title="Respaldos y restore">
              ⛁ Backup
            </button>
          )}
        <div className="tab-bar">
          {workspace.tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === workspace.activeTabId ? "active" : ""}`}
              onClick={() => ws.setActiveTab(wsId, t.id)}
            >
              {t.title}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  ws.closeTab(wsId, t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button className="tab-add" onClick={() => ws.addTab(wsId)}>
            +
          </button>
        </div>
      </div>

      <PanelGroup direction="horizontal" className="workspace-body">
        <Panel defaultSize={20} minSize={12}>
          <SchemaTree
            schema={schema}
            error={schemaError}
            onBrowseTable={browseTable}
            onRefresh={() => void ws.loadSchema(wsId, true)}
          />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel minSize={30}>
          {tab ? (
            <PanelGroup direction="vertical">
              <Panel defaultSize={40} minSize={15}>
                <div className="editor-pane">
                  <div className="editor-toolbar">
                    <button
                      className="primary"
                      disabled={tab.result.running}
                      onClick={() => run(tab.id)}
                      title="Ctrl+Shift+Enter ejecuta todo · Ctrl+Enter ejecuta la selección o el statement bajo el cursor"
                    >
                      ▶ Run
                    </button>
                    {tab.result.running && (
                      <button onClick={() => void ws.cancelQuery(wsId, tab.id)}>
                        ■ Cancel
                      </button>
                    )}
                    {engine !== "redis" && (
                      <button
                        onClick={() =>
                          ws.setTabSql(wsId, tab.id, beautify(tab.sql, engine))
                        }
                        title="Beautify (formatear SQL)"
                      >
                        ✨ Format
                      </button>
                    )}
                    <button onClick={() => setFavName("")} title="Guardar como favorita">
                      ★ Favorita
                    </button>
                    <button
                      className={tab.splitSql !== null ? "active" : undefined}
                      onClick={() =>
                        ws.setTabSplit(wsId, tab.id, tab.splitSql === null ? tab.sql : null)
                      }
                      title="Dividir editor: el panel derecho es una copia independiente del SQL"
                    >
                      ⫽ Split
                    </button>
                    <span className="spacer" />
                    {tab.result.rows.length > 0 && (
                      <>
                        <button onClick={() => void doExport("csv")}>CSV</button>
                        <button onClick={() => void doExport("json")}>JSON</button>
                        <button onClick={() => void doExport("sql")}>SQL</button>
                      </>
                    )}
                  </div>
                  <div className={`editor-panes ${tab.splitSql !== null ? "split" : ""}`}>
                    <SqlEditor
                      value={tab.sql}
                      engine={engine}
                      schema={schema}
                      onChange={(sql) => ws.setTabSql(wsId, tab.id, sql)}
                      onRun={(selection) => run(tab.id, false, selection)}
                      apiRef={editorApi}
                    />
                    {tab.splitSql !== null && (
                      <SqlEditor
                        value={tab.splitSql}
                        engine={engine}
                        schema={schema}
                        onChange={(sql) => ws.setTabSplit(wsId, tab.id, sql)}
                        // Sin selección (Ctrl+Shift+Enter) ejecuta todo el panel derecho.
                        onRun={(selection) =>
                          void ws.runQuery(wsId, tab.id, false, selection ?? tab.splitSql ?? "")
                        }
                      />
                    )}
                  </div>
                </div>
              </Panel>
              <PanelResizeHandle className="resize-handle horizontal" />
              <Panel minSize={20}>
                <div className="results-pane">
                  {tab.result.warnings.length > 0 && (
                    <div className="warning-banner">
                      <strong>⚠ Safe Mode:</strong>{" "}
                      {tab.result.warnings.join("; ")}
                      <button
                        className="danger"
                        onClick={() =>
                          run(tab.id, true, tab.result.executedSql ?? undefined)
                        }
                      >
                        Ejecutar igualmente
                      </button>
                    </div>
                  )}
                  {tab.result.error && (
                    <div className="error-banner">{tab.result.error}</div>
                  )}
                  {notice && (
                    <div className="notice-banner" onClick={() => setNotice(null)}>
                      {notice}
                    </div>
                  )}
                  <ResultsGrid wsId={wsId} tab={tab} />
                  <div className="results-status">
                    {tab.result.running && <span>Ejecutando…</span>}
                    {!tab.result.running && tab.result.columns.length > 0 && (
                      <span>
                        {tab.result.rows.length} fila(s)
                        {tab.result.truncated && " (parcial)"}
                      </span>
                    )}
                    {tab.result.affected != null && (
                      <span>{tab.result.affected} afectada(s)</span>
                    )}
                    {tab.result.truncated && (
                      <button onClick={() => void ws.fetchMore(wsId, tab.id)}>
                        Cargar más
                      </button>
                    )}
                    {tab.result.editability &&
                      !tab.result.editability.editable &&
                      tab.result.columns.length > 0 && (
                        <span className="dim" title={tab.result.editability.reason ?? ""}>
                          solo lectura
                        </span>
                      )}
                    {tab.result.editability?.editable && (
                      <>
                        <button onClick={() => ws.addInsertRow(wsId, tab.id)}>
                          + Fila
                        </button>
                        {pendingCount > 0 && (
                          <>
                            <span className="pending-badge">
                              {pendingCount} cambio(s)
                            </span>
                            <button className="primary" onClick={() => void showPreview()}>
                              Preview
                            </button>
                            <button
                              className="danger"
                              onClick={() => ws.discardChanges(wsId, tab.id)}
                            >
                              Discard
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          ) : (
            <div className="empty-state">
              <button onClick={() => ws.addTab(wsId)}>Nueva query</button>
            </div>
          )}
        </Panel>
      </PanelGroup>

      {preview && tab && (
        <CodePreviewModal
          preview={preview}
          applying={applying}
          onCommit={() => void commit()}
          onDiscard={() => {
            setPreview(null);
            ws.discardChanges(wsId, tab.id);
          }}
          onClose={() => setPreview(null)}
        />
      )}

      {showBackup && (
        <BackupModal
          connId={connId}
          connName={config.name}
          engine={engine}
          database={database}
          onClose={() => setShowBackup(false)}
        />
      )}

      {showDbPicker && (
        <DatabasePicker
          connId={connId}
          current={database}
          databases={info?.databases ?? [database]}
          // Abre la database en una entrada nueva del rail; la actual no cambia.
          onSelect={openDatabase}
          onClose={() => setShowDbPicker(false)}
        />
      )}
      {favName !== null && tab && (
        <div className="modal-backdrop" onClick={() => setFavName(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Guardar query favorita</h3>
            <p className="dim">
              Conexión: {config.name} — Database: {database}
            </p>
            <input
              autoFocus
              placeholder="Nombre de la query…"
              value={favName}
              onChange={(e) => setFavName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && favName) void saveFavorite();
              }}
            />
            <div className="modal-actions">
              <button onClick={() => setFavName(null)}>Cancelar</button>
              <button className="primary" disabled={!favName} onClick={() => void saveFavorite()}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
