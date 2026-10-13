import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ipc, errorMessage } from "../../ipc/commands";
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
        setDone("✓ Respaldo completado (VACUUM INTO)");
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
          Respaldos — {connName}
          <span className="spacer" />
          {(["backup", "restore", "tools"] as Mode[]).map((m) => (
            <button
              key={m}
              className={mode === m ? "primary" : ""}
              onClick={() => setMode(m)}
            >
              {m === "backup" ? "Backup" : m === "restore" ? "Restore" : "Herramientas"}
            </button>
          ))}
        </h3>

        {mode === "tools" && (
          <div className="tools-list">
            {tools.map((t) => (
              <div key={t.name} className="tool-row">
                <code>{t.name}</code>
                {t.path ? (
                  <span className="test-ok">
                    {t.version ?? "encontrado"} — {t.path}
                  </span>
                ) : (
                  <span className="test-fail">no encontrado</span>
                )}
                <button
                  onClick={async () => {
                    const p = await open({ multiple: false });
                    if (typeof p === "string") {
                      await ipc.setBackupToolPath(t.name, p);
                      setTools(await ipc.detectBackupTools());
                    }
                  }}
                >
                  Elegir ruta…
                </button>
              </div>
            ))}
          </div>
        )}

        {mode === "backup" && (
          <div className="backup-form">
            {isSqlite ? (
              <p className="dim">
                SQLite se respalda con una copia consistente del archivo (VACUUM
                INTO) — no requiere herramientas externas.
              </p>
            ) : (
              <>
                {engine === "postgres" && (
                  <label>
                    Formato
                    <select value={format} onChange={(e) => setFormat(e.target.value)}>
                      <option value="custom">Custom (-Fc, recomendado)</option>
                      <option value="plain">Plain SQL</option>
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
                  Solo estructura (schema only)
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
                  Solo datos (data only)
                </label>
              </>
            )}
            <div className="modal-actions">
              <button className="primary" disabled={running} onClick={() => void startBackup()}>
                {running ? "Ejecutando…" : "Iniciar backup"}
              </button>
            </div>
          </div>
        )}

        {mode === "restore" && (
          <div className="backup-form">
            <label>
              Archivo de dump
              <div className="file-row">
                <input value={input} readOnly placeholder="Elegir archivo…" />
                <button onClick={() => void pickRestoreFile()}>…</button>
              </div>
            </label>
            {sniff && (
              <p className={sniff.kind === "unknown" ? "test-fail" : "test-ok"}>
                Formato detectado: {sniff.note}
                {sniff.restoreTool && ` → se restaurará con ${sniff.restoreTool}`}
              </p>
            )}
            <label>
              Database destino
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
                  --clean (eliminar objetos antes de recrear)
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={singleTx}
                    onChange={(e) => setSingleTx(e.target.checked)}
                  />
                  --single-transaction (todo o nada)
                </label>
              </>
            )}
            <div className="modal-actions">
              <button
                className="primary"
                disabled={running || !input || !targetDb || sniff?.kind === "unknown"}
                onClick={() => void startRestore()}
              >
                {running ? "Ejecutando…" : "Iniciar restore"}
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
              Cancelar job
            </button>
          )}
          <button onClick={onClose} disabled={running}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
