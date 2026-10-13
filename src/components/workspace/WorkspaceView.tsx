import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useConnections } from "../../stores/connectionsStore";
import {
  findTab,
  useWorkspaces,
  type QueryTab,
  type Workspace,
} from "../../stores/workspaceStore";
import { ipc, errorMessage } from "../../ipc/commands";
import type { Engine, FavoriteQuery, MutationPreview } from "../../ipc/types";
import { beautify, uglify } from "../../lib/format";
import { useShortcutLabel, useShortcuts } from "../../lib/shortcuts";
import { useT } from "../../i18n";
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
  const t = useT();
  const keyOpenDb = useShortcutLabel("openDatabase");
  const keyRunCurrent = useShortcutLabel("runCurrent");
  const keyRunAll = useShortcutLabel("runAll");
  const keyBeautify = useShortcutLabel("beautify");
  const keySplit = useShortcutLabel("toggleSplit");
  const keyLeftPane = useShortcutLabel("focusLeftPane");
  const keyRightPane = useShortcutLabel("focusRightPane");
  const { saved, infos } = useConnections();
  const ws = useWorkspaces();
  const config = saved.find((c) => c.id === connId);
  const info = infos[connId];
  const engine: Engine = config?.engine ?? "postgres";

  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId);
  const { database, schema, schemaError } = workspace;
  /** Otra database de la conexión: se abre como entrada propia en el rail. */
  const openDatabase = (db: string) => {
    ws.openWorkspace(connId, db);
    ws.requestEditorFocus();
  };
  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [favName, setFavName] = useState<string | null>(null);
  const [showBackup, setShowBackup] = useState(false);
  const [backupSupported, setBackupSupported] = useState(false);
  const editorApi = useRef<EditorApi | null>(null);
  const splitApi = useRef<EditorApi | null>(null);
  /** Panel cuyo preview de cambios está abierto (destino del commit). */
  const previewPane = useRef<string | null>(null);
  // Panel con foco cuando hay split: la toolbar y los atajos actúan sobre él.
  const [focusedSplit, setFocusedSplit] = useState(false);
  const pane: QueryTab | undefined = focusedSplit && tab?.split ? tab.split : tab;
  const apiFor = (p: QueryTab) => (p.id === tab?.id ? editorApi : splitApi);

  // Al llegar a este workspace con una petición de foco pendiente (Ctrl+K),
  // el foco va al editor de la query abierta. El editor (hijo) ya montó y
  // registró su API cuando corre este efecto.
  const focusRequested = useWorkspaces((s) => s.editorFocusRequested);
  useEffect(() => {
    if (!focusRequested) return;
    useWorkspaces.getState().consumeEditorFocus();
    // Tras cerrar el picker, para que nada le vuelva a robar el foco.
    requestAnimationFrame(() => editorApi.current?.focus());
  }, [focusRequested, workspace.id]);
  const [showDbPicker, setShowDbPicker] = useState(false);

  /** Ejecuta en el panel: la selección de su editor si la hay; si no, todo su texto. */
  const run = (p: QueryTab, confirmDangerous = false, selection?: string) => {
    const sel = selection ?? apiFor(p).current?.getSelection();
    void ws.runQuery(wsId, p.id, confirmDangerous, sel || undefined);
  };

  useEffect(() => {
    void ipc
      .getPlatformCapabilities()
      .then((caps) => setBackupSupported(caps.backupSupported))
      .catch(() => {});
  }, []);

  const pendingOf = (p: QueryTab | undefined) =>
    p ? Object.keys(p.result.changes).length + p.result.inserts.length : 0;
  const pendingCount = pendingOf(pane);

  /** Tab anterior/siguiente (circular). */
  const cycleTab = (delta: number) => {
    const tabs = workspace.tabs;
    const idx = tabs.findIndex((t) => t.id === workspace.activeTabId);
    if (tabs.length < 2 || idx === -1) return;
    ws.setActiveTab(wsId, tabs[(idx + delta + tabs.length) % tabs.length].id);
  };
  const modalOpen = preview !== null || favName !== null || showBackup || showDbPicker;

  /** Split: cambia el panel activo y lleva el foco a su editor. */
  const focusPane = (split: boolean) => {
    if (!tab?.split) return;
    setFocusedSplit(split);
    requestAnimationFrame(() => (split ? splitApi : editorApi).current?.focus());
  };
  const toggleSplit = () => {
    if (!tab) return;
    const opening = !tab.split;
    ws.setTabSplit(wsId, tab.id, opening);
    setFocusedSplit(opening);
    if (opening) requestAnimationFrame(() => splitApi.current?.focus());
  };

  // Atajos del workspace (configurables en Settings → Keyboard shortcuts).
  useShortcuts([
    { keys: ["Escape"], enabled: modalOpen, run: () => {
      setPreview(null);
      setFavName(null);
      setShowBackup(false);
      setShowDbPicker(false);
    } },
    { action: "newTab", run: () => ws.addTab(wsId) },
    { action: "closeTab", enabled: !!tab, run: () => tab && ws.closeTab(wsId, tab.id) },
    { action: "nextTab", run: () => cycleTab(1) },
    { action: "prevTab", run: () => cycleTab(-1) },
    // Reload: repite la última query ejecutada del panel (o todo su editor).
    { action: "reload", enabled: !!pane && !pane.result.running, run: () =>
      pane && run(pane, false, pane.result.executedSql ?? pane.sql) },
    { action: "previewChanges", enabled: pendingCount > 0, run: () => void showPreview(pane) },
    // Commit: en Safe Mode siempre pasa por el preview.
    { action: "commitChanges", enabled: pendingCount > 0 && !applying, run: () =>
      void (config?.safeMode ? showPreview(pane) : commit(pane)) },
    { action: "beautify", enabled: !!pane && engine !== "redis", run: () =>
      pane && ws.setTabSql(wsId, pane.id, beautify(pane.sql, engine)) },
    { action: "uglify", enabled: !!pane && engine !== "redis", run: () =>
      pane && ws.setTabSql(wsId, pane.id, uglify(pane.sql)) },
    { action: "openDatabase", enabled: !!info?.capabilities.multipleDatabases, run: () =>
      setShowDbPicker(true) },
    { action: "toggleSplit", enabled: !!tab, run: toggleSplit },
    // Estilo tmux: Ctrl+Space y luego ← / →.
    { action: "focusLeftPane", enabled: !!tab?.split, run: () => focusPane(false) },
    { action: "focusRightPane", enabled: !!tab?.split, run: () => focusPane(true) },
    // "Logout": cierra el workspace y desconecta.
    { action: "closeWorkspace", run: () => ws.closeWorkspace(wsId) },
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

  /** Abre el preview de cambios del panel `target` (y lo recuerda para el commit). */
  const showPreview = async (target: QueryTab | undefined) => {
    if (!target?.result.editability) return;
    previewPane.current = target.id;
    try {
      const changes = ws.pendingChanges(wsId, target.id);
      if (changes.length === 0) return;
      setPreview(await ipc.previewMutations(connId, target.result.editability, changes));
    } catch (e) {
      setNotice(errorMessage(e));
    }
  };

  /** Aplica los cambios pendientes del panel `target`. */
  const commit = async (target: QueryTab | undefined) => {
    if (!target?.result.editability) return;
    setApplying(true);
    try {
      const changes = ws.pendingChanges(wsId, target.id);
      const result = await ipc.applyMutations(
        connId,
        database,
        target.result.editability,
        changes,
      );
      setPreview(null);
      ws.discardChanges(wsId, target.id);
      setNotice(t("ws.noticeAffected", { n: result.affectedTotal }));
      void ws.runQuery(wsId, target.id);
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setApplying(false);
    }
  };

  const saveFavorite = async () => {
    if (!pane || !favName) return;
    const favorite: FavoriteQuery = {
      id: "",
      name: favName,
      sql: pane.sql,
      connId,
      database,
      tags: [],
      createdAt: 0,
    };
    await ipc.saveFavorite(favorite);
    setFavName(null);
    setNotice(t("ws.noticeFavorite"));
  };

  const doExport = async (format: ExportFormat) => {
    if (!pane) return;
    const ok = await exportResult(
      format,
      pane.result.columns,
      pane.result.rows,
      pane.result.editability?.table ?? undefined,
    );
    if (ok) setNotice(t("ws.noticeExported", { format: format.toUpperCase() }));
  };

  /** Columna de un panel: su editor arriba y su grid de resultados abajo. */
  const renderColumn = (p: QueryTab, isSplit: boolean) => {
    const pending = pendingOf(p);
    const focused = !!tab?.split && focusedSplit === isSplit;
    return (
      <div
        className={`query-column ${focused ? "focused" : ""}`}
        onFocusCapture={() => setFocusedSplit(isSplit)}
        onMouseDownCapture={() => setFocusedSplit(isSplit)}
      >
        <PanelGroup direction="vertical">
          <Panel defaultSize={40} minSize={15}>
            <div className="editor-panes">
              <SqlEditor
                value={p.sql}
                engine={engine}
                schema={schema}
                onChange={(sql) => ws.setTabSql(wsId, p.id, sql)}
                onRun={(selection) => run(p, false, selection ?? p.sql)}
                apiRef={isSplit ? splitApi : editorApi}
              />
            </div>
          </Panel>
          <PanelResizeHandle className="resize-handle horizontal" />
          <Panel minSize={20}>
            <div className="results-pane">
              {p.result.warnings.length > 0 && (
                <div className="warning-banner">
                  <strong>{t("ws.safeWarning")}</strong> {p.result.warnings.join("; ")}
                  <button
                    className="danger"
                    onClick={() => run(p, true, p.result.executedSql ?? undefined)}
                  >
                    {t("ws.runAnyway")}
                  </button>
                </div>
              )}
              {p.result.error && <div className="error-banner">{p.result.error}</div>}
              {notice && p.id === pane?.id && (
                <div className="notice-banner" onClick={() => setNotice(null)}>
                  {notice}
                </div>
              )}
              <ResultsGrid wsId={wsId} tab={p} />
              <div className="results-status">
                {p.result.running && <span>{t("common.running")}</span>}
                {!p.result.running && p.result.columns.length > 0 && (
                  <span>
                    {t("ws.rows", { n: p.result.rows.length })}
                    {p.result.truncated && t("ws.partial")}
                  </span>
                )}
                {p.result.affected != null && <span>{t("ws.affected", { n: p.result.affected })}</span>}
                {p.result.truncated && (
                  <button onClick={() => void ws.fetchMore(wsId, p.id)}>{t("ws.loadMore")}</button>
                )}
                {p.result.editability &&
                  !p.result.editability.editable &&
                  p.result.columns.length > 0 && (
                    <span className="dim" title={p.result.editability.reason ?? ""}>
                      {t("ws.readOnly")}
                    </span>
                  )}
                {p.result.editability?.editable && (
                  <>
                    <button onClick={() => ws.addInsertRow(wsId, p.id)}>{t("ws.addRow")}</button>
                    {pending > 0 && (
                      <>
                        <span className="pending-badge">{t("ws.changes", { n: pending })}</span>
                        <button
                          className="primary"
                          onClick={() => {
                            setFocusedSplit(isSplit);
                            void showPreview(p);
                          }}
                        >
                          {t("ws.preview")}
                        </button>
                        <button
                          className="danger"
                          onClick={() => ws.discardChanges(wsId, p.id)}
                        >
                          {t("ws.discard")}
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>
    );
  };

  if (!config) return null;

  return (
    <div className="workspace-view">
      <div className="workspace-header">
        <span className="conn-name" style={{ color: config.color ?? undefined }}>
          {config.name}
        </span>
        {config.safeMode ? (
          <span className="safe-badge">{t("safe.on")}</span>
        ) : (
          <span className="safe-badge off">{t("safe.off")}</span>
        )}
        {info?.capabilities.multipleDatabases && (
          <select
            title={t("ws.openDatabase", { keys: keyOpenDb })}
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
            <button onClick={() => setShowBackup(true)} title={t("ws.backupTitle")}>
              {t("ws.backup")}
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
          {tab && pane ? (
            <div className="query-area">
              <div className="editor-toolbar">
                <button
                  className="primary"
                  disabled={pane.result.running}
                  onClick={() => run(pane)}
                  title={t("ws.runTitle", { current: keyRunCurrent, all: keyRunAll })}
                >
                  {t("ws.run")}
                </button>
                {pane.result.running && (
                  <button onClick={() => void ws.cancelQuery(wsId, pane.id)}>{t("ws.cancel")}</button>
                )}
                {engine !== "redis" && (
                  <button
                    onClick={() => ws.setTabSql(wsId, pane.id, beautify(pane.sql, engine))}
                    title={t("ws.formatTitle", { keys: keyBeautify })}
                  >
                    {t("ws.format")}
                  </button>
                )}
                <button onClick={() => setFavName("")} title={t("ws.favoriteTitle")}>
                  {t("ws.favorite")}
                </button>
                <button
                  className={tab.split ? "active" : undefined}
                  onClick={toggleSplit}
                  title={t("ws.splitTitle", { keys: keySplit })}
                >
                  {t("ws.split")}
                </button>
                {tab.split && (
                  <span
                    className="dim pane-indicator"
                    title={t("ws.splitHint", { left: keyLeftPane, right: keyRightPane })}
                  >
                    {t("ws.activePane", {
                      side: focusedSplit ? t("ws.paneRight") : t("ws.paneLeft"),
                    })}
                  </span>
                )}
                <span className="spacer" />
                {pane.result.rows.length > 0 && (
                  <>
                    <button onClick={() => void doExport("csv")}>CSV</button>
                    <button onClick={() => void doExport("json")}>JSON</button>
                    <button onClick={() => void doExport("sql")}>SQL</button>
                  </>
                )}
              </div>
              {tab.split ? (
                <PanelGroup direction="horizontal" className="query-columns">
                  <Panel minSize={20}>{renderColumn(tab, false)}</Panel>
                  <PanelResizeHandle className="resize-handle" />
                  <Panel minSize={20}>{renderColumn(tab.split, true)}</Panel>
                </PanelGroup>
              ) : (
                renderColumn(tab, false)
              )}
            </div>
          ) : (
            <div className="empty-state">
              <button onClick={() => ws.addTab(wsId)}>{t("ws.newQuery")}</button>
            </div>
          )}
        </Panel>
      </PanelGroup>

      {preview && (
        <CodePreviewModal
          preview={preview}
          applying={applying}
          // El commit aplica sobre el panel cuyo preview está abierto.
          onCommit={() => void commit(findTab(workspace, previewPane.current ?? ""))}
          onDiscard={() => {
            setPreview(null);
            ws.discardChanges(wsId, previewPane.current ?? pane?.id ?? "");
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
      {favName !== null && pane && (
        <div className="modal-backdrop" onClick={() => setFavName(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("ws.favModalTitle")}</h3>
            <p className="dim">
              {t("ws.favModalInfo", { conn: config.name, db: database })}
            </p>
            <input
              autoFocus
              placeholder={t("ws.favModalPlaceholder")}
              value={favName}
              onChange={(e) => setFavName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && favName) void saveFavorite();
              }}
            />
            <div className="modal-actions">
              <button onClick={() => setFavName(null)}>{t("common.cancel")}</button>
              <button className="primary" disabled={!favName} onClick={() => void saveFavorite()}>
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
