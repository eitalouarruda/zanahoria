import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ipc, errorMessage } from "../../ipc/commands";
import { useT, type MessageKey } from "../../i18n";
import { en } from "../../i18n/en";

/**
 * Al arrancar busca una versión nueva en las releases de GitHub y, si la hay,
 * pregunta. Al aceptar se descarga, Zanahoria se cierra y arranca la nueva.
 */
export default function UpdateDialog() {
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  /** Parte descargada (0..1); `null` mientras aún no llegó ningún aviso. */
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc.checkUpdate().then((info) => info && setVersion(info.version));
    const unlisten = listen<{ downloaded: number; total: number }>(
      "update:progress",
      ({ payload }) => setDone(payload.total > 0 ? payload.downloaded / payload.total : 0),
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  if (!version) return null;

  const install = async () => {
    setInstalling(true);
    setError(null);
    setDone(null);
    try {
      // Si sale bien, Zanahoria se cierra y arranca la versión nueva.
      await ipc.installUpdate();
    } catch (e) {
      const message = errorMessage(e);
      setError(message in en ? t(message as MessageKey) : message);
      setInstalling(false);
    }
  };

  const body = !installing
    ? t("update.body")
    : done === null || done < 1
      ? t("update.downloading", { percent: Math.floor((done ?? 0) * 100) })
      : t("update.restarting");

  return (
    <div className="modal-backdrop">
      <div className="modal update-dialog" role="dialog" aria-modal="true">
        <h3>{t("update.title", { version })}</h3>
        <p className="dim">{body}</p>
        {installing && <progress max={1} value={done ?? undefined} />}
        {error && (
          <div className="error-banner preview-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={() => setVersion(null)} disabled={installing}>
            {t("update.later")}
          </button>
          <button className="primary" onClick={install} disabled={installing}>
            {t("update.install")}
          </button>
        </div>
      </div>
    </div>
  );
}
