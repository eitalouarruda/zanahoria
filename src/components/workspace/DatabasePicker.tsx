import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../ipc/commands";
import { useConnections } from "../../stores/connectionsStore";
import { useT } from "../../i18n";

interface Props {
  connId: string;
  current: string;
  /** El engine permite crear databases (ofrece "crear «texto»"). */
  canCreate: boolean;
  onSelect: (database: string) => void;
  onClose: () => void;
}

/**
 * "Open a database" (Ctrl+K / Cmd+K): lista filtrable de las
 * databases del servidor conectado. Flechas para moverse, Enter abre la
 * database elegida en un tab nuevo.
 *
 * La lista vive en el store de conexiones (la misma del selector del
 * header): si el texto no coincide con ninguna database se ofrece crearla,
 * y la nueva aparece en ambos lados.
 */
export default function DatabasePicker({ connId, current, canCreate, onSelect, onClose }: Props) {
  const t = useT();
  const known = useConnections((s) => s.infos[connId]?.databases);
  const all = known && known.length > 0 ? known : [current];
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Refresca en segundo plano: puede haber databases creadas por fuera.
  useEffect(() => {
    void useConnections.getState().refreshDatabases(connId).catch(() => {});
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

  // "Crear «texto»" va al final cuando nada coincide exactamente.
  const newName = filter.trim();
  const offerCreate = canCreate && newName !== "" && !all.includes(newName);
  const count = items.length + (offerCreate ? 1 : 0);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      await useConnections.getState().createDatabase(connId, newName);
      onSelect(newName);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  // Al abrir, preseleccionar la database actual; al filtrar, la primera.
  useEffect(() => {
    const i = filter ? 0 : items.indexOf(current);
    setIndex(Math.max(0, i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, items.length]);

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (i: number) => {
    if (offerCreate && i === items.length) {
      void create();
      return;
    }
    const db = items[i];
    if (!db) return;
    onSelect(db);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        setIndex((i) => Math.min(count - 1, i + 1));
        break;
      case "ArrowUp":
        setIndex((i) => Math.max(0, i - 1));
        break;
      case "PageDown":
        setIndex((i) => Math.min(count - 1, i + 10));
        break;
      case "PageUp":
        setIndex((i) => Math.max(0, i - 10));
        break;
      case "Enter":
        choose(index);
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
              onClick={() => choose(i)}
            >
              {db}
              {db === current && <span className="dim">{t("picker.current")}</span>}
            </li>
          ))}
          {offerCreate && (
            <li
              role="option"
              aria-selected={index === items.length}
              className={`picker-create ${index === items.length ? "selected" : ""}`}
              onMouseMove={() => setIndex(items.length)}
              onClick={() => choose(items.length)}
            >
              {creating ? t("picker.creating") : t("picker.create", { name: newName })}
            </li>
          )}
          {count === 0 && <li className="dim empty">{t("picker.empty")}</li>}
        </ul>
        {error && <div className="test-fail picker-error">{error}</div>}
        <div className="picker-hint dim">
          {t("picker.hint")}
          {canCreate && ` · ${t("picker.createHint")}`}
        </div>
      </div>
    </div>
  );
}
