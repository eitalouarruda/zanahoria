import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ipc, errorMessage } from "../../ipc/commands";
import { useT } from "../../i18n";
import type {
  BackupEvent,
  Engine,
  SniffResult,
  ToolStatus,
} from "../../ipc/types";

interface Props {
  connId: string;
  connName: string;
  engine: Engine;
  database: string;
  onClose: () => void;
}

type Mode = "backup" | "restore" | "tools";

export default function BackupModal({ connId, connName, engine, database, onClose }: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>("backup");
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  // backup opts
  const [format, setFormat] = useState(engine === "postgres" ? "custom" : "plain");
  const [schemaOnly, setSchemaOnly] = useState(false);
  const [dataOnly, setDataOnly] = useState(false);

  // restore opts
  const [input, setInput] = useState("");
  const [sniff, setSniff] = useState<SniffResult | null>(null);
  const [targetDb, setTargetDb] = useState(database);
  const [clean, setClean] = useState(false);
  const [singleTx, setSingleTx] = useState(true);

  useEffect(() => {
    void ipc.detectBackupTools().then(setTools).catch(() => {});
    const unlisten = listen<BackupEvent>("backup:event", (e) => {
      const ev = e.payload;
      if (ev.kind === "line") {
        setLog((l) => [...l.slice(-500), ev.text]);
      } else {
        setDone(ev.success ? `✓ ${ev.message}` : `✗ ${ev.message}`);
        setJobId(null);
      }
      logRef.current?.scrollTo(0, logRef.current.scrollHeight);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const isSqlite = engine === "sqlite";
  const running = jobId != null;

  const startBackup = async () => {
    setLog([]);
    setDone(null);
    try {
      if (isSqlite) {
        const dest = await save({ defaultPath: `${connName}.sqlite` });
        if (!dest) return;
        await ipc.sqliteBackup(connId, dest);
        setDone(t("backup.sqliteDone"));
        return;
      }
      const ext = engine === "postgres" && format === "custom" ? "dump" : "sql";
      const output = await save({ defaultPath: `${connName}-${database}.${ext}` });
      if (!output) return;
      const [id, cmd] = await ipc.startBackup(connId, {
        format,
        output,
        schemaOnly,
        dataOnly,
        tables: [],
      });
      setLog([`$ ${cmd}`]);
      setJobId(id);
    } catch (e) {
      setDone(`✗ ${errorMessage(e)}`);
    }
  };

  const pickRestoreFile = async () => {
    const path = await open({ multiple: false, directory: false });
    if (typeof path !== "string") return;
    setInput(path);
    setSniff(null);
    try {
      setSniff(await ipc.sniffDumpFile(path));
    } catch (e) {
      setDone(`✗ ${errorMessage(e)}`);
    }
  };

  const startRestore = async () => {
    setLog([]);
    setDone(null);
    try {
      const [id, cmd] = await ipc.startRestore(connId, {
        input,
        targetDb,
        clean,
        singleTransaction: singleTx,
      });
      setLog([`$ ${cmd}`]);
      setJobId(id);
    } catch (e) {
      setDone(`✗ ${errorMessage(e)}`);
    }
  };

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal backup-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {t("backup.title", { name: connName })}
          <span className="spacer" />
          {(["backup", "restore", "tools"] as Mode[]).map((m) => (
            <button
              key={m}
              className={mode === m ? "primary" : ""}
              onClick={() => setMode(m)}
            >
              {m === "backup"
                ? t("backup.tabBackup")
                : m === "restore"
                  ? t("backup.tabRestore")
                  : t("backup.tabTools")}
            </button>
          ))}
        </h3>

        {mode === "tools" && (
          <div className="tools-list">
            {tools.map((tool) => (
              <div key={tool.name} className="tool-row">
                <code>{tool.name}</code>
                {tool.path ? (
                  <span className="test-ok">
                    {tool.version ?? t("backup.found")} — {tool.path}
                  </span>
                ) : (
                  <span className="test-fail">{t("backup.notFound")}</span>
                )}
                <button
                  onClick={async () => {
                    const p = await open({ multiple: false });
                    if (typeof p === "string") {
                      await ipc.setBackupToolPath(tool.name, p);
                      setTools(await ipc.detectBackupTools());
                    }
                  }}
                >
                  {t("backup.choosePath")}
                </button>
              </div>
            ))}
          </div>
        )}

        {mode === "backup" && (
          <div className="backup-form">
            {isSqlite ? (
              <p className="dim">
                {t("backup.sqliteNote")}
              </p>
            ) : (
              <>
                {engine === "postgres" && (
                  <label>
                    {t("backup.format")}
                    <select value={format} onChange={(e) => setFormat(e.target.value)}>
                      <option value="custom">{t("backup.formatCustom")}</option>
                      <option value="plain">{t("backup.formatPlain")}</option>
                    </select>
                  </label>
                )}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={schemaOnly}
                    onChange={(e) => {
                      setSchemaOnly(e.target.checked);
                      if (e.target.checked) setDataOnly(false);
                    }}
                  />
                  {t("backup.schemaOnly")}
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={dataOnly}
                    onChange={(e) => {
                      setDataOnly(e.target.checked);
                      if (e.target.checked) setSchemaOnly(false);
                    }}
                  />
                  {t("backup.dataOnly")}
                </label>
              </>
            )}
            <div className="modal-actions">
              <button className="primary" disabled={running} onClick={() => void startBackup()}>
                {running ? t("common.running") : t("backup.start")}
              </button>
            </div>
          </div>
        )}

        {mode === "restore" && (
          <div className="backup-form">
            <label>
              {t("backup.dumpFile")}
              <div className="file-row">
                <input value={input} readOnly placeholder={t("backup.pickFile")} />
                <button onClick={() => void pickRestoreFile()}>…</button>
              </div>
            </label>
            {sniff && (
              <p className={sniff.kind === "unknown" ? "test-fail" : "test-ok"}>
                {t("backup.detected", { note: sniff.note })}
                {sniff.restoreTool && t("backup.restoreWith", { tool: sniff.restoreTool })}
              </p>
            )}
            <label>
              {t("backup.targetDb")}
              <input value={targetDb} onChange={(e) => setTargetDb(e.target.value)} />
            </label>
            {engine === "postgres" && (
              <>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={clean}
                    onChange={(e) => setClean(e.target.checked)}
                  />
                  {t("backup.clean")}
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={singleTx}
                    onChange={(e) => setSingleTx(e.target.checked)}
                  />
                  {t("backup.singleTx")}
                </label>
              </>
            )}
            <div className="modal-actions">
              <button
                className="primary"
                disabled={running || !input || !targetDb || sniff?.kind === "unknown"}
                onClick={() => void startRestore()}
              >
                {running ? t("common.running") : t("backup.startRestore")}
              </button>
            </div>
          </div>
        )}

        {(log.length > 0 || done) && mode !== "tools" && (
          <>
            <pre className="preview-sql backup-log" ref={logRef}>
              {log.join("\n")}
            </pre>
            {done && (
              <p className={done.startsWith("✓") ? "test-ok" : "test-fail"}>{done}</p>
            )}
          </>
        )}

        <div className="modal-actions">
          {running && jobId && (
            <button className="danger" onClick={() => void ipc.cancelJob(jobId)}>
              {t("backup.cancelJob")}
            </button>
          )}
          <button onClick={onClose} disabled={running}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
