import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { ConnectionConfig, Engine } from "../../ipc/types";
import { ipc, errorMessage } from "../../ipc/commands";
import { useT } from "../../i18n";

const ENGINES: { value: Engine; label: string }[] = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "mariadb", label: "MariaDB" },
  { value: "sqlite", label: "SQLite" },
  { value: "redis", label: "Redis" },
];

const DEFAULT_PORTS: Record<Engine, number | null> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlite: null,
  redis: 6379,
};

interface Props {
  initial: ConnectionConfig | null;
  onSave: (config: ConnectionConfig) => Promise<void>;
  onCancel: () => void;
}

export default function ConnectionForm({ initial, onSave, onCancel }: Props) {
  const [config, setConfig] = useState<ConnectionConfig>(
    initial ?? {
      id: crypto.randomUUID(),
      name: "",
      engine: "postgres",
      host: "localhost",
      port: 5432,
      database: "",
      user: "",
      password: "",
      useTls: false,
      safeMode: true,
      color: null,
    },
  );
  const t = useT();
  const [testResult, setTestResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const setEngine = (engine: Engine) =>
    setConfig((c) => ({ ...c, engine, port: DEFAULT_PORTS[engine] }));

  const isFile = config.engine === "sqlite";

  const test = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      await ipc.testConnection(config);
      setTestResult(t("form.testOk"));
    } catch (e) {
      setTestResult(`✗ ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connection-form">
      <h3>{initial ? t("form.editTitle") : t("form.newTitle")}</h3>
      <label>
        {t("form.name")}
        <input value={config.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label>
        {t("form.engine")}
        <select
          value={config.engine}
          onChange={(e) => setEngine(e.target.value as Engine)}
        >
          {ENGINES.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      {isFile ? (
        <label>
          {t("form.file")}
          <div className="file-row">
            <input
              value={config.database}
              onChange={(e) => set("database", e.target.value)}
              placeholder={t("form.filePlaceholder")}
            />
            <button
              onClick={async () => {
                const path = await open({ multiple: false });
                if (typeof path === "string") set("database", path);
              }}
            >
              …
            </button>
          </div>
        </label>
      ) : (
        <>
          <div className="form-row">
            <label>
              {t("form.host")}
              <input value={config.host} onChange={(e) => set("host", e.target.value)} />
            </label>
            <label className="port">
              {t("form.port")}
              <input
                type="number"
                value={config.port ?? ""}
                onChange={(e) =>
                  set("port", e.target.value ? Number(e.target.value) : null)
                }
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              {t("form.user")}
              <input value={config.user} onChange={(e) => set("user", e.target.value)} />
            </label>
            <label>
              {t("form.password")}
              <input
                type="password"
                value={config.password ?? ""}
                onChange={(e) => set("password", e.target.value)}
                placeholder={initial ? t("form.passwordUnchanged") : ""}
              />
            </label>
          </div>
          <label>
            {t("form.database")} {config.engine === "redis" && t("form.redisDbHint")}
            <input
              value={config.database}
              onChange={(e) => set("database", e.target.value)}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={config.useTls}
              onChange={(e) => set("useTls", e.target.checked)}
            />
            {t("form.useTls")}
          </label>
        </>
      )}
      <label className="checkbox safe-mode-option">
        <input
          type="checkbox"
          checked={config.safeMode}
          onChange={(e) => set("safeMode", e.target.checked)}
        />
        <span>
          <strong>Safe Mode</strong> — {t("form.safeModeDesc")}
        </span>
      </label>
      {testResult && (
        <p className={testResult.startsWith("✓") ? "test-ok" : "test-fail"}>
          {testResult}
        </p>
      )}
      <div className="modal-actions">
        <button onClick={onCancel}>{t("common.cancel")}</button>
        <button disabled={busy} onClick={() => void test()}>
          {busy ? t("form.testing") : t("form.test")}
        </button>
        <button
          className="primary"
          disabled={!config.name || busy}
          onClick={() => {
            const toSave = { ...config };
            if (initial && !toSave.password) delete toSave.password;
            void onSave(toSave);
          }}
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
