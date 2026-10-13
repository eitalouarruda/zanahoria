import { useState } from "react";
import type { DbSchema } from "../../ipc/types";
import { useT } from "../../i18n";

interface Props {
  schema: DbSchema | null;
  error: string | null;
  onBrowseTable: (namespace: string | null, table: string) => void;
  onRefresh: () => void;
}

export default function SchemaTree({ schema, error, onBrowseTable, onRefresh }: Props) {
  const t = useT();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");

  if (!schema) {
    return (
      <div className="schema-tree">
        {error ? (
          <>
            <p className="test-fail">{error}</p>
            <button onClick={onRefresh}>{t("common.retry")}</button>
          </>
        ) : (
          <p className="dim">{t("schema.loading")}</p>
        )}
      </div>
    );
  }

  const single = schema.namespaces.length === 1;

  return (
    <div className="schema-tree">
      <div className="schema-toolbar">
        <input
          placeholder={t("schema.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button title={t("schema.refresh")} onClick={onRefresh}>
          ↻
        </button>
      </div>
      {schema.namespaces.map((ns) => {
        const tables = ns.tables.filter((tb) =>
          tb.name.toLowerCase().includes(filter.toLowerCase()),
        );
        return (
          <div key={ns.name}>
            {!single && <div className="schema-ns">{ns.name}</div>}
            {tables.map((tb) => {
              const key = `${ns.name}.${tb.name}`;
              return (
                <div key={key}>
                  <div
                    className="schema-table"
                    onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
                    onDoubleClick={() =>
                      onBrowseTable(single ? null : ns.name, tb.name)
                    }
                    title={t("schema.browseHint")}
                  >
                    <span className="table-icon">{tb.kind === "view" ? "👁" : "▤"}</span>
                    {tb.name}
                  </div>
                  {open[key] && (
                    <div className="schema-columns">
                      {tb.columns.map((c) => (
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
