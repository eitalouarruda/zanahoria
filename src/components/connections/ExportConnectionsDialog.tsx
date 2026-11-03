import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import QRCode from "qrcode";
import { useT } from "../../i18n";
import { ipc, errorMessage } from "../../ipc/commands";
import type { SavedConnection } from "../../ipc/types";
import { copyText } from "../../lib/clipboard";
import { exportFileText, splitForQr } from "../../lib/connTransfer";

/** Clave mínima: protege passwords de bases de datos fuera del dispositivo. */
const MIN_PASSPHRASE = 6;
/** Tiempo que se muestra cada QR cuando hay varios. */
const QR_INTERVAL_MS = 1800;

interface Props {
  connections: SavedConnection[];
  /** Conexiones marcadas al abrir (todas si se abre desde la cabecera). */
  initial: string[];
  onClose: () => void;
}

export default function ExportConnectionsDialog({ connections, initial, onClose }: Props) {
  const t = useT();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial));
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** QR en pantalla: textos ya partidos. */
  const [qr, setQr] = useState<string[] | null>(null);

  const ids = connections.filter((c) => picked.has(c.id)).map((c) => c.id);
  const passError =
    pass.length > 0 && pass.length < MIN_PASSPHRASE
      ? t("transfer.passTooShort", { n: MIN_PASSPHRASE })
      : confirm.length > 0 && confirm !== pass
        ? t("transfer.passMismatch")
        : null;
  const ready = ids.length > 0 && pass.length >= MIN_PASSPHRASE && pass === confirm && !busy;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Cifra en el backend (Argon2 tarda un momento) y entrega el paquete. */
  const run = async (then: (token: string) => Promise<void> | void) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await then(await ipc.exportConnections(ids, pass));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveFile = () =>
    run(async (token) => {
      const path = await save({
        defaultPath: "zanahoria-connections.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!path) return;
      await ipc.saveTextFile(path, exportFileText(token, ids.length));
      setNotice(t("transfer.saved", { n: ids.length }));
    });

  const copy = () =>
    run(async (token) => {
      await copyText(token);
      setNotice(t("transfer.copied", { n: ids.length }));
    });

  if (qr) {
    return <QrView parts={qr} count={ids.length} onBack={() => setQr(null)} onClose={onClose} />;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal transfer-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void run((token) => setQr(splitForQr(token)));
        }}
      >
        <h3>{t("transfer.exportTitle")}</h3>
        <div className="transfer-pick-head">
          <span className="dim">{t("transfer.selected", { n: ids.length, total: connections.length })}</span>
          <button
            type="button"
            onClick={() =>
              setPicked(
                ids.length === connections.length
                  ? new Set()
                  : new Set(connections.map((c) => c.id)),
              )
            }
          >
            {ids.length === connections.length ? t("transfer.none") : t("transfer.all")}
          </button>
        </div>
        <div className="transfer-list">
          {connections.map((c) => (
            <label key={c.id} className="transfer-item">
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="transfer-name">{c.name}</span>
              {c.group && <span className="transfer-tag">{c.group}</span>}
              {!c.hasPassword && <span className="transfer-tag dim">{t("transfer.noPassword")}</span>}
            </label>
          ))}
        </div>
        <p className="dim transfer-hint">{t("transfer.passHint")}</p>
        <input
          type="password"
          autoFocus
          autoComplete="new-password"
          placeholder={t("transfer.passphrase")}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder={t("transfer.passConfirm")}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {passError && <div className="test-fail">{passError}</div>}
        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="test-ok">{notice}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {t("common.close")}
          </button>
          <button type="button" disabled={!ready} onClick={() => void copy()}>
            {t("transfer.copyText")}
          </button>
          <button type="button" disabled={!ready} onClick={() => void saveFile()}>
            {t("transfer.saveTxt")}
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            {busy ? t("transfer.encrypting") : t("transfer.showQr")}
          </button>
        </div>
      </form>
    </div>
  );
}

/** QR a pantalla completa; con varias partes van rotando solas. */
function QrView({
  parts,
  count,
  onBack,
  onClose,
}: {
  parts: string[];
  count: number;
  onBack: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(parts.length > 1);
  const [svgs, setSvgs] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void Promise.all(
      parts.map((p) =>
        QRCode.toString(p, { type: "svg", errorCorrectionLevel: "M", margin: 3 }),
      ),
    ).then((list) => alive && setSvgs(list));
    return () => {
      alive = false;
    };
  }, [parts]);

  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % parts.length), QR_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [auto, parts.length]);

  const step = (delta: number) => {
    setAuto(false);
    setIndex((i) => (i + delta + parts.length) % parts.length);
  };
  const svg = useMemo(() => svgs[index], [svgs, index]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal transfer-dialog qr-view"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t("transfer.qrTitle", { n: count })}</h3>
        <p className="dim transfer-hint">
          {parts.length > 1 ? t("transfer.qrMultiHint", { n: parts.length }) : t("transfer.qrHint")}
        </p>
        {/* SVG generado localmente por la librería qrcode. */}
        <div className="qr-image" dangerouslySetInnerHTML={{ __html: svg ?? "" }} />
        {parts.length > 1 && (
          <div className="qr-nav">
            <button type="button" onClick={() => step(-1)}>
              ‹
            </button>
            <span>{t("transfer.qrPart", { i: index + 1, n: parts.length })}</span>
            <button type="button" onClick={() => step(1)}>
              ›
            </button>
            <button type="button" onClick={() => setAuto((a) => !a)}>
              {auto ? t("transfer.pause") : t("transfer.play")}
            </button>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onBack}>
            {t("transfer.back")}
          </button>
          <button type="button" className="primary" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
