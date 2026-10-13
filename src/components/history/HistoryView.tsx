import { useEffect, useState } from "react";
import { ipc } from "../../ipc/commands";
import type { HistoryEntry } from "../../ipc/types";
import { useConnections } from "../../stores/connectionsStore";
import { useWorkspaces } from "../../stores/workspaceStore";
import { useT } from "../../i18n";

export default function HistoryView() {
  const t = useT();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [connFilter, setConnFilter] = useState("all");
  const { saved, statuses, connect } = useConnections();
  const ws = useWorkspaces();

  useEffect(() => {
    const args: { connId?: string; search?: string; limit: number } = { limit: 300 };
    if (connFilter !== "all") args.connId = connFilter;
    if (search) args.search = search;
    ipc.getHistory(args).then(setEntries).catch(() => {});
  }, [search, connFilter]);

  const connName = (id: string) => saved.find((c) => c.id === id)?.name ?? id;

  const reopen = async (entry: HistoryEntry) => {
    if (statuses[entry.connId] !== "connected") {
      try {
        await connect(entry.connId);
      } catch {
        return;
      }
    }
    const wsId = ws.openWorkspace(entry.connId, entry.database);
    ws.addTab(wsId, undefined, entry.sql);
  };

  return (
    <div className="global-view">
      <div className="cm-header">
        <h2>{t("history.title")}</h2>
        <input
          placeholder={t("history.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={connFilter} onChange={(e) => setConnFilter(e.target.value)}>
          <option value="all">{t("common.allConnections")}</option>
          {saved.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          className="danger"
          onClick={() => {
            void ipc
              .clearHistory(connFilter === "all" ? undefined : connFilter)
              .then(() => setEntries([]));
          }}
        >
          {t("history.clear")}
        </button>
      </div>
      {entries.length === 0 && <p className="dim">{t("history.empty")}</p>}
      <div className="history-list">
        {entries.map((e) => (
          <div key={e.id} className="history-row" onDoubleClick={() => void reopen(e)}>
            <span className={`status-chip ${e.status}`}>{e.status}</span>
            <code className="history-sql">{e.sql}</code>
            <span className="dim">
              {connName(e.connId)} · {e.durationMs}ms ·{" "}
              {new Date(e.executedAt * 1000).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
