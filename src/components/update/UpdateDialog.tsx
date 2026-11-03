import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ipc, errorMessage } from "../../ipc/commands";
import { useT, type MessageKey } from "../../i18n";
import { en } from "../../i18n/en";

/**
 * Al arrancar busca una versión nueva en las releases de GitHub y, si la hay,
 * pregunta. Al aceptar se descarga, Zanahoria se cierra y arranca la nueva.
 * En Android se abre la descarga del APK y el usuario lo instala.
 */
export default function UpdateDialog() {
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  /** Android: la descarga ya se abrió en el navegador. */
  const [opened, setOpened] = useState(false);
  const [installing, setInstalling] = useState(false);
  /** Parte descargada (0..1); `null` mientras aún no llegó ningún aviso. */
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc.checkUpdate().then((info) => {
      if (!info) return;
      setVersion(info.version);
      setManual(info.manual);
    });
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
      if (manual) {
        setOpened(true);
        setInstalling(false);
      }
    } catch (e) {
      const message = errorMessage(e);
      setError(message in en ? t(message as MessageKey) : message);
      setInstalling(false);
    }
  };

  const body = opened
    ? t("update.apkOpened")
    : manual
      ? t("update.bodyApk")
      : !installing
        ? t("update.body")
        : done === null || done < 1
          ? t("update.downloading", { percent: Math.floor((done ?? 0) * 100) })
          : t("update.restarting");

  return (
    <div className="modal-backdrop">
      <div className="modal update-dialog" role="dialog" aria-modal="true">
        <h3>{t("update.title", { version })}</h3>
        <p className="dim">{body}</p>
        {installing && !manual && <progress max={1} value={done ?? undefined} />}
        {error && (
          <div className="error-banner preview-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={() => setVersion(null)} disabled={installing}>
            {opened ? t("common.close") : t("update.later")}
          </button>
          {!opened && (
            <button className="primary" onClick={install} disabled={installing}>
              {manual ? t("update.download") : t("update.install")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
