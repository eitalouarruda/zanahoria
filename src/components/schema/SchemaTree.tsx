import { useState } from "react";
import type { DbSchema } from "../../ipc/types";

interface Props {
  schema: DbSchema | null;
  error: string | null;
  onBrowseTable: (namespace: string | null, table: string) => void;
  onRefresh: () => void;
}

export default function SchemaTree({ schema, error, onBrowseTable, onRefresh }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");

  if (!schema) {
    return (
      <div className="schema-tree">
        {error ? (
          <>
            <p className="test-fail">{error}</p>
            <button onClick={onRefresh}>Reintentar</button>
          </>
        ) : (
          <p className="dim">Cargando schema…</p>
        )}
      </div>
    );
  }

  const single = schema.namespaces.length === 1;

  return (
    <div className="schema-tree">
      <div className="schema-toolbar">
        <input
          placeholder="Filtrar tablas…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button title="Refrescar schema" onClick={onRefresh}>
          ⟳
        </button>
      </div>
      {schema.namespaces.map((ns) => {
        const tables = ns.tables.filter((t) =>
          t.name.toLowerCase().includes(filter.toLowerCase()),
        );
        return (
          <div key={ns.name}>
            {!single && <div className="schema-ns">{ns.name}</div>}
            {tables.map((t) => {
              const key = `${ns.name}.${t.name}`;
              return (
                <div key={key}>
                  <div
                    className="schema-table"
                    onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
                    onDoubleClick={() =>
                      onBrowseTable(single ? null : ns.name, t.name)
                    }
                    title="Doble click: ver datos"
                  >
                    <span className="table-icon">{t.kind === "view" ? "👁" : "▤"}</span>
                    {t.name}
                  </div>
                  {open[key] && (
                    <div className="schema-columns">
                      {t.columns.map((c) => (
                        <div key={c.name} className="schema-column">
                          <span className={c.isPk ? "pk" : ""}>{c.name}</span>
                          <span className="col-type">{c.dbType}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
