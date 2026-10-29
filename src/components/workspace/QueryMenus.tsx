import { useEffect, useRef, useState, type ReactNode } from "react";
import { ipc, errorMessage } from "../../ipc/commands";
import type { FavoriteQuery, HistoryEntry } from "../../ipc/types";
import { useT } from "../../i18n";

interface DropdownProps {
  label: ReactNode;
  title: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  children: ReactNode;
}

/** Botón de la toolbar con un panel desplegable debajo (cierra con Esc o clic fuera). */
function ToolbarDropdown({ label, title, open, setOpen, children }: DropdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <div className="toolbar-dropdown" ref={ref}>
      <button className={open ? "active" : undefined} title={title} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && <div className="toolbar-dropdown-panel">{children}</div>}
    </div>
  );
}

interface Scope {
  connId: string;
  database: string;
  /** Abre el SQL en una pestaña nueva del workspace actual. */
  onOpen: (sql: string, title?: string) => void;
}

/** Favoritas de esta conexión + database; al final, guardar la query actual. */
export function FavoritesMenu({ connId, database, onOpen, onSaveCurrent, canSave }: Scope & {
  onSaveCurrent: () => void;
  canSave: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [favorites, setFavorites] = useState<FavoriteQuery[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    ipc
      .listFavorites()
      .then((all) => setFavorites(all.filter((f) => f.connId === connId && f.database === database)))
      .catch((e) => setError(errorMessage(e)));
  }, [open, connId, database]);

  return (
    <ToolbarDropdown label={t("ws.favorite")} title={t("ws.favoritesTitle")} open={open} setOpen={setOpen}>
      {error && <div className="error-banner">{error}</div>}
      {favorites.length === 0 && !error && <p className="dim dropdown-empty">{t("fav.emptyHere")}</p>}
      <div className="dropdown-list">
        {favorites.map((fav) => (
          <div key={fav.id} className="dropdown-item" title={fav.sql}>
            <button
              className="dropdown-item-main"
              onClick={() => {
                setOpen(false);
                onOpen(fav.sql, fav.name);
              }}
            >
              <strong>{fav.name}</strong>
              <code>{fav.sql}</code>
            </button>
            <button
              className="dropdown-item-delete"
              title={t("common.delete")}
              aria-label={t("common.delete")}
              onClick={() => {
                void ipc
                  .deleteFavorite(fav.id)
                  .then(() => setFavorites((prev) => prev.filter((f) => f.id !== fav.id)));
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="dropdown-footer">
        <button
          disabled={!canSave}
          onClick={() => {
            setOpen(false);
            onSaveCurrent();
          }}
        >
          {t("ws.favoriteSaveCurrent")}
        </button>
      </div>
    </ToolbarDropdown>
  );
}

/** Historial de queries ejecutadas en esta conexión + database. */
export function HistoryMenu({ connId, database, onOpen }: Scope) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    const args: { connId: string; search?: string; limit: number } = { connId, limit: 500 };
    if (search) args.search = search;
    ipc
      .getHistory(args)
      .then((all) => setEntries(all.filter((e) => e.database === database)))
      .catch(() => {});
  }, [open, search, connId, database]);

  return (
    <ToolbarDropdown label={t("ws.history")} title={t("ws.historyTitle")} open={open} setOpen={setOpen}>
      <input
        autoFocus
        className="dropdown-search"
        placeholder={t("history.search")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {entries.length === 0 && <p className="dim dropdown-empty">{t("history.empty")}</p>}
      <div className="dropdown-list">
        {entries.map((e) => (
          <button
            key={e.id}
            className="dropdown-item dropdown-item-main"
            title={e.sql}
            onClick={() => {
              setOpen(false);
              onOpen(e.sql);
            }}
          >
            <span className="dropdown-item-meta">
              <span className={`status-chip ${e.status}`}>{e.status}</span>
              <span className="dim">
                {e.durationMs}ms · {new Date(e.executedAt * 1000).toLocaleString()}
              </span>
            </span>
            <code>{e.sql}</code>
          </button>
        ))}
      </div>
    </ToolbarDropdown>
  );
}
