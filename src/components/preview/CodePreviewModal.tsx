import type { MutationPreview } from "../../ipc/types";

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
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal code-preview" onClick={(e) => e.stopPropagation()}>
        <h3>
          Code Review{" "}
          {preview.safeMode && <span className="safe-badge">SAFE MODE</span>}
        </h3>
        <pre className="preview-sql">
          {preview.statements.map((s) => s.previewSql + ";").join("\n")}
        </pre>
        <p className="dim">
          {preview.statements.length} statement(s) — se ejecuta en una transacción
          {preview.safeMode &&
            " con verificación de filas afectadas (rollback si no coincide)"}
          .
        </p>
        <div className="modal-actions">
          <button className="danger" onClick={onDiscard} disabled={applying}>
            Discard
          </button>
          <button onClick={onClose} disabled={applying}>
            Seguir editando
          </button>
          <button className="primary" onClick={onCommit} disabled={applying}>
            {applying ? "Aplicando…" : "Commit"}
          </button>
        </div>
      </div>
    </div>
  );
}
