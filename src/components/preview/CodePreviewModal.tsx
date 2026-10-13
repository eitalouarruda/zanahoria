import type { MutationPreview } from "../../ipc/types";
import { useT } from "../../i18n";

interface Props {
  preview: MutationPreview;
  applying: boolean;
  onCommit: () => void;
  onDiscard: () => void;
  onClose: () => void;
}

/** Code Review: muestra el SQL que se ejecutará. Commit aplica en transacción. */
export default function CodePreviewModal({
  preview,
  applying,
  onCommit,
  onDiscard,
  onClose,
}: Props) {
  const t = useT();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal code-preview" onClick={(e) => e.stopPropagation()}>
        <h3>
          {t("preview.title")}{" "}
          {preview.safeMode && <span className="safe-badge">{t("safe.on")}</span>}
        </h3>
        <pre className="preview-sql">
          {preview.statements.map((s) => s.previewSql + ";").join("\n")}
        </pre>
        <p className="dim">
          {t("preview.summary", { n: preview.statements.length })}
          {preview.safeMode && t("preview.safeCheck")}.
        </p>
        <div className="modal-actions">
          <button className="danger" onClick={onDiscard} disabled={applying}>
            {t("ws.discard")}
          </button>
          <button onClick={onClose} disabled={applying}>
            {t("preview.keepEditing")}
          </button>
          <button className="primary" onClick={onCommit} disabled={applying}>
            {applying ? t("preview.applying") : t("preview.commit")}
          </button>
        </div>
      </div>
    </div>
  );
}
