import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ipc, errorMessage } from "../../ipc/commands";
import { useConnections } from "../../stores/connectionsStore";
import { useWorkspaces } from "../../stores/workspaceStore";
import { useT, type MessageKey } from "../../i18n";
import { en } from "../../i18n/en";
import type {
  BackupEvent,
  BackupProgress,
  Engine,
  PlatformCapabilities,
  RestorePlan,
  SavedConnection,
  SniffResult,
  ToolStatus,
} from "../../ipc/types";
import {
  defaultBackupName,
  explainResult,
  formatBytes,
  suggestDbName,
  versionLabel,
} from "./backupText";

type Action = "restore" | "backup";
type Step = "action" | "connection" | "details" | "running" | "result";
type T = ReturnType<typeof useT>;

const ENGINE_ICONS: Record<Engine, string> = {
  postgres: "🐘",
  mysql: "🐬",
  mariadb: "🦭",
  sqlite: "🪶",
  redis: "♦️",
};

/** Job en curso o terminado (lo que muestran los pasos de progreso y resultado). */
interface Job {
  id: string | null;
  action: Action;
  connId: string;
  database: string;
  /** Archivo de origen (restore) o destino (backup). */
  file: string;
  command: string;
  log: string[];
  done: number;
  total: number;
  /** "bytes" = progreso en bytes leídos; "tables" = tablas procesadas. */
  unit: "bytes" | "tables";
  startedAt: number;
  result: { success: boolean; message: string } | null;
}

/**
 * Respaldos y restauración como asistente: qué hacer → conexión → archivo y
 * destino → progreso → resultado. Las opciones técnicas quedan en
 * "Opciones avanzadas" y los valores por defecto son los seguros (database
 * nueva, todo o nada, sin permisos del servidor de origen).
 */
export default function BackupView() {
  const t = useT();
  const [step, setStep] = useState<Step>("action");
  const [action, setAction] = useState<Action>("restore");
  const [connId, setConnId] = useState<string | null>(null);
  const [caps, setCaps] = useState<PlatformCapabilities | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef<Job | null>(null);
  jobRef.current = job;
  const conn = useConnections((s) => s.saved.find((c) => c.id === connId));

  useEffect(() => {
    void ipc.getPlatformCapabilities().then(setCaps).catch(() => {});
    const offEvent = listen<BackupEvent>("backup:event", (e) => {
      const ev = e.payload;
      setJob((j) => {
        if (!j || j.id !== ev.jobId) return j;
        if (ev.kind === "line") return { ...j, log: [...j.log.slice(-1999), ev.text] };
        return { ...j, result: { success: ev.success, message: ev.message } };
      });
      if (ev.kind === "done") {
        const current = jobRef.current;
        if (current?.id === ev.jobId) {
          setStep("result");
          // El restore pudo crear la database: actualizar listas (header y Ctrl+K).
          void useConnections.getState().refreshDatabases(current.connId).catch(() => {});
        }
      }
    });
    const offProgress = listen<BackupProgress>("backup:progress", (e) => {
      const p = e.payload;
      setJob((j) => (j && j.id === p.jobId ? { ...j, done: p.done, total: p.total } : j));
    });
    return () => {
      void offEvent.then((fn) => fn());
      void offProgress.then((fn) => fn());
    };
  }, []);

  const steps: MessageKey[] = [
    "bk.step.action",
    "bk.step.connection",
    action === "restore" ? "bk.step.restoreDetails" : "bk.step.backupDetails",
    "bk.step.progress",
  ];
  // En el resultado todos los pasos quedan marcados como hechos.
  const stepIndex = { action: 0, connection: 1, details: 2, running: 3, result: 4 }[step];

  const startJob = (j: Omit<Job, "log" | "done" | "total" | "startedAt" | "result">) => {
    setJob({ ...j, log: [], done: 0, total: 0, startedAt: Date.now(), result: null });
    setStep(j.id ? "running" : "result");
  };

  const reset = () => {
    setJob(null);
    setStep("action");
    setConnId(null);
  };

  return (
    <div className="global-view bk-view">
      <div className="bk-header">
        <h2>{t("bk.title")}</h2>
        <ol className="bk-steps">
          {steps.map((key, i) => (
            <li
              key={key}
              className={i === stepIndex ? "current" : i < stepIndex ? "done" : ""}
            >
              <span className="bk-step-num">{i < stepIndex ? "✓" : i + 1}</span>
              {t(key)}
            </li>
          ))}
        </ol>
      </div>

      <div className="bk-body">
        {step === "action" && (
          <ActionStep
            caps={caps}
            onChoose={(a) => {
              setAction(a);
              setStep("connection");
            }}
          />
        )}
        {step === "connection" && (
          <ConnectionStep
            action={action}
            caps={caps}
            onBack={() => setStep("action")}
            onChoose={(id) => {
              setConnId(id);
              setStep("details");
            }}
          />
        )}
        {step === "details" && conn && action === "restore" && (
          <RestoreStep
            conn={conn}
            onBack={() => setStep("connection")}
            onStarted={(id, command, database, file, unit) =>
              startJob({ id, action, connId: conn.id, database, file, command, unit })
            }
          />
        )}
        {step === "details" && conn && action === "backup" && (
          <BackupStep
            conn={conn}
            onBack={() => setStep("connection")}
            onStarted={(id, command, database, file) =>
              startJob({ id, action, connId: conn.id, database, file, command, unit: "tables" })
            }
            onSqliteDone={(file, error) => {
              startJob({ id: null, action, connId: conn.id, database: "", file, command: "VACUUM INTO", unit: "tables" });
              setJob((j) =>
                j && {
                  ...j,
                  result: error
                    ? { success: false, message: error }
                    : { success: true, message: "completed — sqlite" },
                },
              );
            }}
          />
        )}
        {step === "running" && job && <RunningStep job={job} />}
        {step === "result" && job?.result && (
          <ResultStep
            job={job}
            onRetry={() => {
              setJob(null);
              setStep("details");
            }}
            onAgain={reset}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- pasos */

function ActionStep({
  caps,
  onChoose,
}: {
  caps: PlatformCapabilities | null;
  onChoose: (a: Action) => void;
}) {
  const t = useT();
  const [tools, setTools] = useState<ToolStatus[]>([]);
  useEffect(() => {
    void ipc.detectBackupTools().then(setTools).catch(() => {});
  }, []);
  const mobile = caps ? !caps.backupSupported : false;
  return (
    <>
      <p className="bk-lead">{t("bk.action.question")}</p>
      <div className="bk-cards">
        <button className="bk-card" disabled={mobile} onClick={() => onChoose("restore")}>
          <span className="bk-card-icon">📥</span>
          <strong>{t("bk.action.restore")}</strong>
          <span className="dim">{t("bk.action.restoreHint")}</span>
        </button>
        <button className="bk-card" onClick={() => onChoose("backup")}>
          <span className="bk-card-icon">📤</span>
          <strong>{t("bk.action.backup")}</strong>
          <span className="dim">{t("bk.action.backupHint")}</span>
        </button>
      </div>
      {mobile && <p className="dim">{t("bk.mobileOnlySqlite")}</p>}
      {tools.length > 0 && (
        <div className="bk-tools dim">
          {t("bk.tools")}{" "}
          {tools.map((tool) => (
            <span key={tool.name} className={tool.path ? "bk-tool ok" : "bk-tool missing"}>
              {tool.path ? "✓" : "✗"} {tool.name}
              {tool.version && ` ${versionLabel(tool.version)}`}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function ConnectionStep({
  action,
  caps,
  onBack,
  onChoose,
}: {
  action: Action;
  caps: PlatformCapabilities | null;
  onBack: () => void;
  onChoose: (connId: string) => void;
}) {
  const t = useT();
  const { saved, statuses, connect } = useConnections();
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [index, setIndex] = useState(0);
  const mobile = caps ? !caps.backupSupported : false;

  const items = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return saved
      .filter((c) => {
        if (c.engine === "redis") return false;
        // SQLite: solo respaldo (VACUUM INTO); en móvil, lo único disponible.
        if (c.engine === "sqlite") return action === "backup";
        return !mobile;
      })
      .filter((c) => {
        const hay = `${c.name} ${c.host} ${c.database} ${c.group ?? ""} ${c.engine}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
  }, [saved, filter, action, mobile]);

  useEffect(() => setIndex(0), [filter]);

  const choose = async (c: SavedConnection | undefined) => {
    if (!c || busy) return;
    setError(null);
    if (statuses[c.id] !== "connected") {
      setBusy(c.id);
      try {
        await connect(c.id);
      } catch (e) {
        setError({ id: c.id, message: errorMessage(e) });
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    onChoose(c.id);
  };

  return (
    <>
      <p className="bk-lead">
        {action === "restore" ? t("bk.conn.questionRestore") : t("bk.conn.questionBackup")}
      </p>
      <input
        className="bk-search"
        autoFocus
        placeholder={t("bk.conn.filter")}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setIndex((i) => Math.min(items.length - 1, i + 1));
          else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
          else if (e.key === "Enter") void choose(items[index]);
          else return;
          e.preventDefault();
        }}
      />
      <ul className="bk-conn-list">
        {items.map((c, i) => (
          <li key={c.id}>
            <button
              className={`bk-conn ${i === index ? "selected" : ""}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => void choose(c)}
              disabled={busy !== null}
            >
              <span className="bk-conn-icon" style={c.color ? { borderColor: c.color } : undefined}>
                {ENGINE_ICONS[c.engine]}
              </span>
              <span className="bk-conn-text">
                <strong>{c.name}</strong>
                <span className="dim">
                  {c.engine === "sqlite" ? c.database : `${c.host}${c.port ? `:${c.port}` : ""}`}
                  {c.group && ` · ${c.group}`}
                </span>
              </span>
              <span className={`status-dot ${statuses[c.id] ?? ""}`} />
              {busy === c.id && <span className="dim">{t("bk.conn.connecting")}</span>}
            </button>
            {error?.id === c.id && <p className="test-fail bk-conn-error">{error.message}</p>}
          </li>
        ))}
        {items.length === 0 && (
          <li className="dim bk-empty">
            {saved.length === 0 ? t("bk.conn.none") : t("bk.conn.noMatch")}
          </li>
        )}
      </ul>
      <div className="bk-footer">
        <button onClick={onBack}>← {t("bk.back")}</button>
      </div>
    </>
  );
}

function RestoreStep({
  conn,
  onBack,
  onStarted,
}: {
  conn: SavedConnection;
  onBack: () => void;
  onStarted: (
    jobId: string,
    command: string,
    database: string,
    file: string,
    unit: "bytes" | "tables",
  ) => void;
}) {
  const t = useT();
  const databases = useConnections((s) => s.infos[conn.id]?.databases ?? []);
  const [file, setFile] = useState("");
  const [sniff, setSniff] = useState<SniffResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [newName, setNewName] = useState("");
  const [existingDb, setExistingDb] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [singleTx, setSingleTx] = useState(true);
  const [continueOnError, setContinueOnError] = useState(false);
  const [keepPrivileges, setKeepPrivileges] = useState(false);
  const [safeConfirmed, setSafeConfirmed] = useState(false);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planNonce, setPlanNonce] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const targetDb = (mode === "new" ? newName : existingDb).trim();
  const nameTaken = mode === "new" && databases.includes(targetDb);

  const pickFile = async () => {
    const path = await open({ multiple: false, directory: false });
    if (typeof path !== "string") return;
    setFile(path);
    setPlan(null);
    setFileError(null);
    try {
      const s = await ipc.sniffDumpFile(path);
      setSniff(s);
      if (s.kind === "unknown") setFileError(t("bk.file.unknown"));
      setNewName(suggestDbName(s.sourceDb, path, databases));
    } catch (e) {
      setSniff(null);
      setFileError(errorMessage(e));
    }
  };

  const options = {
    input: file,
    targetDb,
    // Reemplazar una database con contenido = borrar sus objetos antes.
    clean: mode === "existing" && (plan?.targetTables ?? 0) > 0,
    singleTransaction: singleTx,
    createDb: mode === "new",
    continueOnError,
    keepPrivileges,
    confirmSafeMode: conn.safeMode && safeConfirmed,
  };

  useEffect(() => {
    setPlan(null);
    if (!file || !targetDb || !sniff || sniff.kind === "unknown" || nameTaken) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      ipc
        .planRestore(conn.id, options)
        .then((p) => {
          if (stale) return;
          setPlan(p);
          setPlanError(null);
        })
        .catch((e) => !stale && setPlanError(errorMessage(e)));
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, file, targetDb, mode, sniff, nameTaken, planNonce]);

  const replacing = mode === "existing" && (plan?.targetTables ?? 0) > 0;
  const confirmed = !replacing || confirmText.trim() === targetDb;
  // La confirmación nombra el destino: al cambiarlo hay que confirmar de nuevo.
  useEffect(() => setSafeConfirmed(false), [targetDb]);
  const safeOk = !conn.safeMode || safeConfirmed;
  const ready = !!plan && !plan.blocker && !nameTaken && confirmed && safeOk && !starting;

  const start = async () => {
    if (!ready || !plan) return;
    setStarting(true);
    setStartError(null);
    try {
      const [id, command] = await ipc.startRestore(conn.id, options);
      onStarted(id, command, targetDb, file, plan.strategy === "script" ? "bytes" : "tables");
    } catch (e) {
      setStartError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const missingTool = plan?.blocker?.code === "tool_missing" ? plan.blocker.params.tool : null;

  return (
    <>
      <section className="bk-section">
        <h3>
          <span className="bk-section-num">1</span>
          {t("bk.file.title")}
        </h3>
        <button className={`bk-file ${file ? "chosen" : ""}`} onClick={() => void pickFile()}>
          {file ? (
            <>
              <span className="bk-file-icon">📄</span>
              <span className="bk-file-text">
                <strong>{file.split(/[\\/]/).pop()}</strong>
                {sniff && sniff.kind !== "unknown" && (
                  <span className="dim">{describeSniff(t, sniff)}</span>
                )}
              </span>
              <span className="dim">{t("bk.file.change")}</span>
            </>
          ) : (
            <>
              <span className="bk-file-icon">＋</span>
              <span className="bk-file-text">
                <strong>{t("bk.file.choose")}</strong>
                <span className="dim">{t("bk.file.formats")}</span>
              </span>
            </>
          )}
        </button>
        {fileError && <p className="test-fail">{fileError}</p>}
      </section>

      <section className={`bk-section ${!sniff || fileError ? "disabled" : ""}`}>
        <h3>
          <span className="bk-section-num">2</span>
          {t("bk.target.title", { server: conn.name })}
        </h3>
        <label className={`bk-choice ${mode === "new" ? "active" : ""}`}>
          <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
          <span>
            <strong>{t("bk.target.new")}</strong>
            <span className="dim">{t("bk.target.newHint")}</span>
            {mode === "new" && (
              <>
                <input
                  className="bk-inline-input"
                  value={newName}
                  placeholder={t("bk.target.newName")}
                  onChange={(e) => setNewName(e.target.value)}
                />
                {nameTaken && <span className="test-fail">{t("bk.target.nameTaken")}</span>}
              </>
            )}
          </span>
        </label>
        <label className={`bk-choice ${mode === "existing" ? "active" : ""}`}>
          <input
            type="radio"
            checked={mode === "existing"}
            onChange={() => {
              setMode("existing");
              setConfirmText("");
            }}
          />
          <span>
            <strong>{t("bk.target.existing")}</strong>
            <span className="dim">{t("bk.target.existingHint")}</span>
            {mode === "existing" && (
              <select
                className="bk-inline-input"
                value={existingDb}
                onChange={(e) => {
                  setExistingDb(e.target.value);
                  setConfirmText("");
                }}
              >
                <option value="">{t("bk.target.pick")}</option>
                {databases.map((db) => (
                  <option key={db} value={db}>
                    {db}
                  </option>
                ))}
              </select>
            )}
          </span>
        </label>
        {replacing && plan && (
          <div className="bk-danger">
            <strong>⚠ {t("bk.target.replaceWarn", { db: targetDb, n: plan.targetTables ?? 0 })}</strong>
            <span>{t("bk.target.confirm", { db: targetDb })}</span>
            <input
              value={confirmText}
              placeholder={targetDb}
              onChange={(e) => setConfirmText(e.target.value)}
            />
          </div>
        )}
      </section>

      {(plan || planError) && (
        <section className="bk-section">
          <h3>
            <span className="bk-section-num">3</span>
            {t("bk.check.title")}
          </h3>
          {planError && <p className="test-fail">{planError}</p>}
          {plan && (
            <PlanChecks
              plan={plan}
              safe={singleTx && !continueOnError}
              onPickTool={
                missingTool
                  ? async () => {
                      const p = await open({ multiple: false });
                      if (typeof p !== "string") return;
                      await ipc.setBackupToolPath(missingTool, p);
                      setPlanNonce((n) => n + 1);
                    }
                  : undefined
              }
            />
          )}
        </section>
      )}

      <details className="bk-advanced">
        <summary>{t("bk.advanced")}</summary>
        <label className="checkbox">
          <input type="checkbox" checked={singleTx} onChange={(e) => setSingleTx(e.target.checked)} />
          {t("bk.adv.singleTx")}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={continueOnError}
            onChange={(e) => setContinueOnError(e.target.checked)}
          />
          {t("bk.adv.continueOnError")}
        </label>
        {conn.engine === "postgres" && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={keepPrivileges}
              onChange={(e) => setKeepPrivileges(e.target.checked)}
            />
            {t("bk.adv.keepPrivileges")}
          </label>
        )}
      </details>

      {conn.safeMode && plan && !plan.blocker && (
        <div className="bk-safe">
          <strong>🛡 {t("bk.safe.title", { name: conn.name })}</strong>
          <span>{t("bk.safe.body")}</span>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={safeConfirmed}
              onChange={(e) => setSafeConfirmed(e.target.checked)}
            />
            {t("bk.safe.confirm", { db: targetDb })}
          </label>
        </div>
      )}

      {startError && <p className="test-fail">{startError}</p>}
      <div className="bk-footer">
        <button onClick={onBack}>← {t("bk.back")}</button>
        <span className="spacer" />
        <button className="primary bk-go" disabled={!ready} onClick={() => void start()}>
          {starting ? t("common.running") : t("bk.restore.start")}
        </button>
      </div>
    </>
  );
}

/** Lista de comprobaciones del plan en lenguaje llano. */
function PlanChecks({
  plan,
  safe,
  onPickTool,
}: {
  plan: RestorePlan;
  safe: boolean;
  onPickTool?: () => void;
}) {
  const t = useT();
  const warn = (code: string) => plan.warnings.find((w) => w.code === code);
  const downgrade = warn("downgrade");
  const mismatch = warn("engine_mismatch");
  const { sniff } = plan;
  return (
    <ul className="bk-checks">
      {plan.blocker && (
        <li className="bad">
          <span>✗</span>
          <span>
            {noteText(t, "bk.block", plan.blocker.code, plan.blocker.params)}
            {onPickTool && (
              <button className="bk-inline-btn" onClick={onPickTool}>
                {t("bk.pickTool")}
              </button>
            )}
          </span>
        </li>
      )}
      {mismatch && (
        <li className="bad">
          <span>✗</span>
          <span>{noteText(t, "bk.warn", "engine_mismatch", mismatch.params)}</span>
        </li>
      )}
      {downgrade ? (
        <li className="warn">
          <span>⚠</span>
          <span>{noteText(t, "bk.warn", "downgrade", downgrade.params)}</span>
        </li>
      ) : (
        sniff.sourceVersion &&
        plan.targetVersion && (
          <li className="good">
            <span>✓</span>
            <span>
              {t("bk.check.compatible", {
                source: versionLabel(sniff.sourceVersion),
                target: versionLabel(plan.targetVersion),
              })}
            </span>
          </li>
        )
      )}
      {warn("target_version_unknown") && (
        <li className="warn">
          <span>⚠</span>
          <span>{t("bk.warn.target_version_unknown")}</span>
        </li>
      )}
      {plan.fixes.length > 0 && !plan.blocker && (
        <li className="good">
          <span>✓</span>
          <details>
            <summary>{t("bk.check.fixes", { n: plan.fixes.length })}</summary>
            <ul>
              {plan.fixes.map((code) => {
                const [c, param] = code.split(":");
                return <li key={code}>{noteText(t, "bk.fix", c, { param: param ?? "" })}</li>;
              })}
            </ul>
          </details>
        </li>
      )}
      {!plan.blocker && (
        <li className={safe ? "good" : "warn"}>
          <span>{safe ? "✓" : "⚠"}</span>
          <span>{safe ? t("bk.check.safe") : t("bk.check.unsafe")}</span>
        </li>
      )}
      {!plan.blocker && (
        <li className="good">
          <span>✓</span>
          <span>{t("bk.check.verify")}</span>
        </li>
      )}
    </ul>
  );
}

function BackupStep({
  conn,
  onBack,
  onStarted,
  onSqliteDone,
}: {
  conn: SavedConnection;
  onBack: () => void;
  onStarted: (jobId: string, command: string, database: string, file: string) => void;
  onSqliteDone: (file: string, error: string | null) => void;
}) {
  const t = useT();
  const databases = useConnections((s) => s.infos[conn.id]?.databases ?? []);
  const isSqlite = conn.engine === "sqlite";
  const [database, setDatabase] = useState(
    databases.includes(conn.database) ? conn.database : (databases[0] ?? conn.database),
  );
  const [what, setWhat] = useState<"all" | "schema" | "data">("all");
  const [format, setFormat] = useState(conn.engine === "postgres" ? "custom" : "plain");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    const output = await save({
      defaultPath: defaultBackupName(isSqlite ? conn.name : database, conn.engine, format),
    });
    if (!output) return;
    setStarting(true);
    try {
      if (isSqlite) {
        try {
          await ipc.sqliteBackup(conn.id, output);
          onSqliteDone(output, null);
        } catch (e) {
          onSqliteDone(output, errorMessage(e));
        }
        return;
      }
      const [id, command] = await ipc.startBackup(conn.id, {
        format,
        output,
        schemaOnly: what === "schema",
        dataOnly: what === "data",
        tables: [],
        database,
      });
      onStarted(id, command, database, output);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      {!isSqlite && (
        <section className="bk-section">
          <h3>
            <span className="bk-section-num">1</span>
            {t("bk.backup.which")}
          </h3>
          <select className="bk-select" value={database} onChange={(e) => setDatabase(e.target.value)}>
            {databases.map((db) => (
              <option key={db} value={db}>
                {db}
              </option>
            ))}
          </select>
        </section>
      )}
      {!isSqlite && (
        <section className="bk-section">
          <h3>
            <span className="bk-section-num">2</span>
            {t("bk.backup.what")}
          </h3>
          {(["all", "schema", "data"] as const).map((w) => (
            <label key={w} className={`bk-choice ${what === w ? "active" : ""}`}>
              <input type="radio" checked={what === w} onChange={() => setWhat(w)} />
              <span>
                <strong>{t(`bk.backup.${w}` as MessageKey)}</strong>
                <span className="dim">{t(`bk.backup.${w}Hint` as MessageKey)}</span>
              </span>
            </label>
          ))}
        </section>
      )}
      {isSqlite && <p className="bk-lead">{t("bk.backup.sqlite", { name: conn.name })}</p>}
      {conn.engine === "postgres" && (
        <details className="bk-advanced">
          <summary>{t("bk.advanced")}</summary>
          <label className="checkbox">
            <input
              type="radio"
              checked={format === "custom"}
              onChange={() => setFormat("custom")}
            />
            {t("bk.adv.formatCustom")}
          </label>
          <label className="checkbox">
            <input type="radio" checked={format === "plain"} onChange={() => setFormat("plain")} />
            {t("bk.adv.formatPlain")}
          </label>
        </details>
      )}
      <p className="dim bk-note">✓ {t("bk.backup.verifyNote")}</p>
      {error && <p className="test-fail">{error}</p>}
      <div className="bk-footer">
        <button onClick={onBack}>← {t("bk.back")}</button>
        <span className="spacer" />
        <button
          className="primary bk-go"
          disabled={starting || (!isSqlite && !database)}
          onClick={() => void start()}
        >
          {starting ? t("common.running") : t("bk.backup.start")}
        </button>
      </div>
    </>
  );
}

function RunningStep({ job }: { job: Job }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const pct = job.total > 0 ? Math.min(99, Math.floor((job.done / job.total) * 100)) : null;
  const elapsed = Math.max(0, Math.floor((now - job.startedAt) / 1000));
  const detail =
    job.total > 0
      ? job.unit === "bytes"
        ? t("bk.run.bytes", { done: formatBytes(job.done), total: formatBytes(job.total) })
        : t("bk.run.tables", { done: Math.min(job.done, job.total), total: job.total })
      : t("bk.run.preparing");
  return (
    <div className="bk-running">
      <h3>
        {job.action === "restore"
          ? t("bk.run.restoring", { db: job.database })
          : t("bk.run.backingUp", { db: job.database })}
      </h3>
      <div className={`bk-progress ${pct === null ? "indeterminate" : ""}`}>
        <div style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="bk-run-info dim">
        <span>
          {pct !== null && `${pct}% · `}
          {detail}
        </span>
        <span>
          {t("bk.run.elapsed", {
            time: `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`,
          })}
        </span>
      </div>
      <p className="dim">{t("bk.run.keepOpen")}</p>
      <div className="bk-footer">
        <TechDetails job={job} />
        <span className="spacer" />
        <button
          className="danger"
          disabled={cancelling || !job.id}
          onClick={() => {
            if (!job.id || !window.confirm(t("bk.run.confirmCancel"))) return;
            setCancelling(true);
            void ipc.cancelJob(job.id);
          }}
        >
          {t("bk.run.cancel")}
        </button>
      </div>
    </div>
  );
}

function ResultStep({
  job,
  onRetry,
  onAgain,
}: {
  job: Job;
  onRetry: () => void;
  onAgain: () => void;
}) {
  const t = useT();
  const result = job.result!;
  const info = explainResult(job.log, result);
  const ws = useWorkspaces();
  const openDb = () => {
    ws.openWorkspace(job.connId, job.database);
  };
  const title: MessageKey = result.success
    ? job.action === "restore"
      ? "bk.done.restoreOk"
      : "bk.done.backupOk"
    : info.code === "cancelled"
      ? "bk.done.cancelled"
      : job.action === "restore"
        ? "bk.done.restoreFail"
        : "bk.done.backupFail";
  return (
    <div className={`bk-result ${result.success ? "ok" : "fail"}`}>
      <div className="bk-result-icon">{result.success ? "✓" : "✗"}</div>
      <h3>{t(title, { db: job.database })}</h3>
      <p>{t(info.code as MessageKey, info.params)}</p>
      {result.success && job.action === "backup" && (
        <p className="dim bk-path">{job.file}</p>
      )}
      {!result.success && info.lastError && <pre className="bk-last-error">{info.lastError}</pre>}
      <div className="bk-footer">
        {job.log.length > 0 && <TechDetails job={job} open={!result.success && !info.known} />}
        <span className="spacer" />
        {!result.success && <button onClick={onRetry}>{t("bk.done.retry")}</button>}
        <button onClick={onAgain}>{t("bk.done.again")}</button>
        {result.success && job.action === "restore" && (
          <button className="primary" onClick={openDb}>
            {t("bk.done.open", { db: job.database })}
          </button>
        )}
      </div>
    </div>
  );
}

function TechDetails({ job, open: initiallyOpen = false }: { job: Job; open?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [job.log.length]);
  return (
    <details className="bk-tech" open={initiallyOpen}>
      <summary>{t("bk.tech")}</summary>
      <pre ref={ref} className="preview-sql backup-log">
        {`$ ${job.command}\n${job.log.join("\n")}${job.result ? `\n→ ${job.result.message}` : ""}`}
      </pre>
    </details>
  );
}

/* ------------------------------------------------------------- helpers */

function describeSniff(t: T, s: SniffResult): string {
  const engine =
    s.sourceEngine === "postgres"
      ? "PostgreSQL"
      : s.sourceEngine === "mysql"
        ? "MySQL"
        : s.sourceEngine === "mariadb"
          ? "MariaDB"
          : null;
  const parts = [
    engine && s.sourceVersion ? `${engine} ${versionLabel(s.sourceVersion)}` : engine,
    s.sourceDb && t("bk.file.originalDb", { db: s.sourceDb }),
    s.size != null && formatBytes(s.size),
  ];
  return parts.filter(Boolean).join(" · ") || s.note;
}

/** Texto de un código del plan; si no hay traducción, el código crudo. */
function noteText(t: T, prefix: string, code: string, params: Record<string, string>): string {
  const key = `${prefix}.${code}`;
  return key in en ? t(key as MessageKey, params) : code;
}
