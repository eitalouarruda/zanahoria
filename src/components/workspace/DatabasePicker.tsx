import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../../ipc/commands";
import { useT } from "../../i18n";

interface Props {
  connId: string;
  current: string;
  /** Lista ya conocida (ConnInfo); se refresca en segundo plano al abrir. */
  databases: string[];
  onSelect: (database: string) => void;
  onClose: () => void;
}

/**
 * "Open a database" (Ctrl+K / Cmd+K): lista filtrable de las
 * databases del servidor conectado. Flechas para moverse, Enter abre la
 * database elegida en un tab nuevo.
 */
export default function DatabasePicker({ connId, current, databases, onSelect, onClose }: Props) {
  const t = useT();
  const [all, setAll] = useState(databases);
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    void ipc
      .listDatabases(connId)
      .then((dbs) => dbs.length > 0 && setAll(dbs))
      .catch(() => {});
  }, [connId]);

  // Filtro: todas las palabras deben aparecer (sin importar mayúsculas);
  // primero las que empiezan con el texto.
  const items = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = all.filter((db) => words.every((w) => db.toLowerCase().includes(w)));
    const head = words[0] ?? "";
    return matched.sort((a, b) => {
      const pa = a.toLowerCase().startsWith(head) ? 0 : 1;
      const pb = b.toLowerCase().startsWith(head) ? 0 : 1;
      return pa - pb || a.localeCompare(b);
    });
  }, [all, filter]);

  // Al abrir, preseleccionar la database actual; al filtrar, la primera.
  useEffect(() => {
    const i = filter ? 0 : items.indexOf(current);
    setIndex(Math.max(0, i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, items.length]);

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (db: string | undefined) => {
    if (!db) return;
    onSelect(db);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        setIndex((i) => Math.min(items.length - 1, i + 1));
        break;
      case "ArrowUp":
        setIndex((i) => Math.max(0, i - 1));
        break;
      case "PageDown":
        setIndex((i) => Math.min(items.length - 1, i + 10));
        break;
      case "PageUp":
        setIndex((i) => Math.max(0, i - 10));
        break;
      case "Enter":
        choose(items[index]);
        break;
      case "Escape":
        onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="modal-backdrop picker-backdrop" onClick={onClose}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={t("picker.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="picker-list" ref={listRef} role="listbox">
          {items.map((db, i) => (
            <li
              key={db}
              role="option"
              aria-selected={i === index}
              className={`${i === index ? "selected" : ""} ${db === current ? "current" : ""}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => choose(db)}
            >
              {db}
              {db === current && <span className="dim">{t("picker.current")}</span>}
            </li>
          ))}
          {items.length === 0 && <li className="dim empty">{t("picker.empty")}</li>}
        </ul>
        <div className="picker-hint dim">{t("picker.hint")}</div>
      </div>
    </div>
  );
}
