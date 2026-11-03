import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "../../i18n";
import { ipc, errorMessage } from "../../ipc/commands";
import type { ConnectionConfig } from "../../ipc/types";
import {
  addScan,
  emptyScan,
  extractTokens,
  missingParts,
  planImport,
  type ImportItem,
  type ScanProgress,
} from "../../lib/connTransfer";
import { decodeQrImage } from "../../lib/qrImage";
import { groupNames, useConnections } from "../../stores/connectionsStore";
import QrScanner from "./QrScanner";

/** Mensaje del backend para clave incorrecta (`app_store::transfer`). */
const BAD_PASSPHRASE = "bad passphrase or corrupted data";

interface Props {
  onClose: () => void;
  onImported: (count: number) => void;
}

/**
 * Importar conexiones: 1) juntar el paquete cifrado (archivo, QR, imagen o
 * texto pegado), 2) descifrarlo con la clave, 3) elegir qué guardar.
 */
export default function ImportConnectionsDialog({ onClose, onImported }: Props) {
  const t = useT();
  const { saved, emptyGroups, save } = useConnections();
  const [mobile, setMobile] = useState(false);
  const [tokens, setTokens] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress>(emptyScan);
  const progressRef = useRef(progress);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ImportItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const imageInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void ipc
      .getPlatformCapabilities()
      .then((caps) => setMobile(caps.isMobile))
      .catch(() => {});
  }, []);

  const addTokens = (found: string[]) => {
    if (found.length === 0) return false;
    setTokens((prev) => [...new Set([...prev, ...found])]);
    setError(null);
    return true;
  };

  /** Un QR leído (cámara o imagen). Devuelve si completó un paquete. */
  const onQr = (content: string) => {
    const result = addScan(progressRef.current, content);
    progressRef.current = result.progress;
    setProgress(result.progress);
    if (result.kind === "token") {
      addTokens([result.token]);
      setScanning(false);
    } else if (result.kind === "invalid") {
      setError(t("transfer.notOurQr"));
    } else {
      setError(null);
    }
  };

  const scanStatus =
    progress.total > 0
      ? t("transfer.qrProgress", {
          read: progress.total - missingParts(progress).length,
          n: progress.total,
        })
      : null;

  const openFile = async () => {
    setError(null);
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (typeof path !== "string") return;
      if (!addTokens(extractTokens(await ipc.readTextFile(path)))) {
        setError(t("transfer.nothingFound"));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const readImages = async (files: Iterable<Blob>) => {
    setError(null);
    let any = false;
    for (const file of files) {
      try {
        const content = await decodeQrImage(file);
        if (content) {
          any = true;
          onQr(content);
        }
      } catch {
        // Imagen ilegible: se informa abajo si ninguna sirvió.
      }
    }
    if (!any) setError(t("transfer.noQrInImage"));
  };

  /** Pegar una captura con el QR (Ctrl+V) en cualquier parte del diálogo. */
  const onPaste = (e: ClipboardEvent) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    void readImages(images);
  };

  const decrypt = async () => {
    setBusy(true);
    setError(null);
    try {
      const all: ConnectionConfig[] = [];
      for (const token of tokens) all.push(...(await ipc.decryptConnections(token, pass)));
      const plan = planImport(all, saved, groupNames(saved, emptyGroups));
      setItems(plan);
      setPicked(new Set(plan.map((i) => i.config.id)));
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg.includes(BAD_PASSPHRASE) ? t("transfer.badPassphrase") : msg);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!items) return;
    setBusy(true);
    setError(null);
    let count = 0;
    try {
      for (const item of items) {
        if (!picked.has(item.config.id)) continue;
        // Sin password en el paquete: undefined conserva la ya guardada.
        await save({ ...item.config, password: item.config.password ?? undefined });
        count++;
      }
      onImported(count);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const reset = () => {
    setTokens([]);
    setItems(null);
    setPass("");
    setText("");
    progressRef.current = emptyScan();
    setProgress(emptyScan());
    setError(null);
  };

  // Lector nativo: tapa toda la app mientras está abierto.
  const scanner = scanning && (
    <QrScanner
      native={mobile}
      status={scanStatus}
      onText={onQr}
      onClose={() => setScanning(false)}
      onError={(msg) => {
        setScanning(false);
        setError(msg);
      }}
    />
  );

  let body;
  if (items) {
    const n = items.filter((i) => picked.has(i.config.id)).length;
    body = (
      <>
        <p className="dim transfer-hint">{t("transfer.reviewHint")}</p>
        <div className="transfer-list">
          {items.map(({ config, replaces, newGroup }) => (
            <label key={config.id} className="transfer-item">
              <input
                type="checkbox"
                checked={picked.has(config.id)}
                onChange={() => toggle(config.id)}
              />
              <span className="transfer-name">
                {config.name}
                <span className="dim">
                  {config.engine === "sqlite"
                    ? config.database
                    : ` ${config.user}@${config.host}`}
                </span>
              </span>
              {config.group && (
                <span className="transfer-tag" title={newGroup ? t("transfer.newGroup") : undefined}>
                  {newGroup ? "+ " : ""}
                  {config.group}
                </span>
              )}
              <span className={`transfer-tag ${replaces ? "warn" : "ok"}`}>
                {replaces ? t("transfer.replaces") : t("transfer.new")}
              </span>
            </label>
          ))}
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={reset}>
            {t("transfer.back")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={n === 0 || busy}
            onClick={() => void doImport()}
          >
            {t("transfer.importN", { n })}
          </button>
        </div>
      </>
    );
  } else if (tokens.length > 0) {
    body = (
      <form
        className="transfer-step"
        onSubmit={(e) => {
          e.preventDefault();
          if (pass && !busy) void decrypt();
        }}
      >
        <p className="test-ok">{t("transfer.packagesRead", { n: tokens.length })}</p>
        <p className="dim transfer-hint">{t("transfer.enterPass")}</p>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          placeholder={t("transfer.passphrase")}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        {error && <div className="error-banner">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={reset}>
            {t("transfer.back")}
          </button>
          <button type="submit" className="primary" disabled={!pass || busy}>
            {busy ? t("transfer.decrypting") : t("transfer.decrypt")}
          </button>
        </div>
      </form>
    );
  } else {
    body = (
      <>
        <p className="dim transfer-hint">{t("transfer.importHint")}</p>
        <div className="transfer-sources">
          <button type="button" onClick={() => void openFile()}>
            📄 {t("transfer.openTxt")}
          </button>
          <button
            type="button"
            className={scanning ? "active" : ""}
            onClick={() => {
              setError(null);
              setScanning(true);
            }}
          >
            📷 {t("transfer.scanQr")}
          </button>
          <button type="button" onClick={() => imageInput.current?.click()}>
            🖼 {t("transfer.qrImage")}
          </button>
          <input
            ref={imageInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length) void readImages(files);
            }}
          />
        </div>
        {!mobile && scanner}
        {scanStatus && (
          <p className="dim">
            {scanStatus} · {t("transfer.missing", { parts: missingParts(progress).join(", ") })}
          </p>
        )}
        <textarea
          className="transfer-paste"
          rows={4}
          placeholder={t("transfer.pastePlaceholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <div className="error-banner">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!text.trim()}
            onClick={() => {
              if (!addTokens(extractTokens(text))) {
                // Texto de un QR suelto (una parte) también vale.
                onQr(text);
              }
            }}
          >
            {t("transfer.continue")}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal transfer-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !scanning && onClose()}
        onPaste={onPaste}
      >
        <h3>{t("transfer.importTitle")}</h3>
        {body}
      </div>
    </div>
    {/* Fuera del backdrop: sus clics no deben cerrar el diálogo. */}
    {mobile && scanner}
    </>
  );
}
