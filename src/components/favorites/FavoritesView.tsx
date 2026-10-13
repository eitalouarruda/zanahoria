import { useEffect, useState } from "react";
import { ipc, errorMessage } from "../../ipc/commands";
import type { FavoriteQuery } from "../../ipc/types";
import { useConnections } from "../../stores/connectionsStore";
import { useWorkspaces } from "../../stores/workspaceStore";

/** Vista global: favoritas de todas las conexiones/bancos a la vez. */
export default function FavoritesView() {
  const [favorites, setFavorites] = useState<FavoriteQuery[]>([]);
  const [filter, setFilter] = useState("");
  const [connFilter, setConnFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const { saved, statuses, connect } = useConnections();
  const ws = useWorkspaces();

  const load = () => {
    ipc.listFavorites().then(setFavorites).catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, []);

  const connName = (id: string) => saved.find((c) => c.id === id)?.name ?? id;

  const openFavorite = async (fav: FavoriteQuery) => {
    setError(null);
    try {
      if (statuses[fav.connId] !== "connected") {
        await connect(fav.connId);
      }
      const wsId = ws.openWorkspace(fav.connId, fav.database);
      ws.addTab(wsId, fav.name, fav.sql);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const shown = favorites.filter(
    (f) =>
      (connFilter === "all" || f.connId === connFilter) &&
      (f.name.toLowerCase().includes(filter.toLowerCase()) ||
        f.sql.toLowerCase().includes(filter.toLowerCase())),
  );

  return (
    <div className="global-view">
      <div className="cm-header">
        <h2>★ Queries favoritas</h2>
        <input
          placeholder="Buscar…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select value={connFilter} onChange={(e) => setConnFilter(e.target.value)}>
          <option value="all">Todas las conexiones</option>
          {saved.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {shown.length === 0 && <p className="dim">Sin favoritas.</p>}
      <div className="fav-list">
        {shown.map((fav) => (
          <div key={fav.id} className="fav-card">
            <div className="fav-head">
              <strong>{fav.name}</strong>
              <span className="dim">
                {connName(fav.connId)}
                {fav.database && ` / ${fav.database}`}
              </span>
              <span className="spacer" />
              <button className="primary" onClick={() => void openFavorite(fav)}>
                Abrir
              </button>
              <button
                className="danger"
                onClick={() => {
                  void ipc.deleteFavorite(fav.id).then(load);
                }}
              >
                Eliminar
              </button>
            </div>
            <pre className="fav-sql">{fav.sql}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
