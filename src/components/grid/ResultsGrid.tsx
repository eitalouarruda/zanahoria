import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DbValue } from "../../ipc/types";
import { dbValueToDisplay, displayToDbValue } from "../../ipc/types";
import { useWorkspaces, type QueryTab } from "../../stores/workspaceStore";
import { useT } from "../../i18n";
import { columnKeys, computeRowView, type GridSort } from "../../lib/gridView";
import {
  editedCells,
  editedValue,
  editableSource,
  isCellEditable,
  isInsertCellEditable,
  pkValues,
  rowKey,
} from "../../lib/editing";

interface Props {
  /** Id del workspace en el store. */
  wsId: string;
  tab: QueryTab;
  /** Filtro de columnas por nombre (parcial, sin distinguir mayúsculas). */
  columnFilter?: string;
  /** Filtros de filas por columna (nombre → texto); undefined = barra cerrada. */
  rowFilters?: Record<string, string>;
  onRowFilterChange?: (col: string, text: string) => void;
  /** Avisa cuántas filas quedan tras filtrar (null = sin filtro). */
  onShownRowsChange?: (n: number | null) => void;
}

const ROW_HEIGHT = 26;
const MIN_COL_WIDTH = 40;
/** Píxeles que hay que arrastrar una cabecera antes de empezar a moverla. */
const DRAG_THRESHOLD = 5;

export default function ResultsGrid({
  wsId,
  tab,
  columnFilter = "",
  rowFilters,
  onRowFilterChange,
  onShownRowsChange,
}: Props) {
  const { editCell, toggleDeleteRow, editInsertCell, removeInsertRow } = useWorkspaces();
  const t = useT();
  const parentRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{
    row: number;
    col: number;
    insert: boolean;
    text: string;
    /** true: al abrir se selecciona todo el contenido (Enter/F2/doble clic). */
    selectAll: boolean;
  } | null>(null);
  /** Celda activa (navegación con teclado). */
  const [cursor, setCursor] = useState<{ row: number; col: number } | null>(null);

  /** Orden por columna (clic en la cabecera: asc → desc → sin orden). */
  const [sort, setSort] = useState<GridSort | null>(null);
  // El grid se reutiliza entre tabs: el orden es de cada tab.
  useEffect(() => setSort(null), [tab.id]);

  const { columns, rows, editability, changes, inserts } = tab.result;
  // Claves únicas: una query puede devolver nombres repetidos (`SELECT id, *`).
  const keys = useMemo(() => columnKeys(columns), [columns]);
  // Ediciones por fila real: con JOIN, la misma fila de una tabla puede salir
  // en varias filas del resultado y todas deben mostrar el valor editado.
  const edited = useMemo(
    () => editedCells(editability, rows, changes),
    [editability, rows, changes],
  );

  // Orden y ancho de columnas: sólo para la vista actual (no se guardan).
  // Se reinician al cambiar de tab o cuando la query devuelve otras columnas.
  const colsKey = `${tab.id}|${columns.map((c) => c.name).join("\u0000")}`;
  const [colOrder, setColOrder] = useState<{ key: string; order: number[] } | null>(null);
  const [colWidths, setColWidths] = useState<{ key: string; widths: Record<number, number> } | null>(null);
  const order =
    colOrder?.key === colsKey ? colOrder.order : columns.map((_, i) => i);
  const widths = colWidths?.key === colsKey ? colWidths.widths : {};
  /** Columna que se está arrastrando y dónde caería (para pintar el indicador). */
  const [drag, setDrag] = useState<{ col: number; target: number; after: boolean } | null>(null);
  /** El mouseup de un arrastre/resize no debe contar como clic (ordenar). */
  const suppressClick = useRef(false);
  // Vista: índices originales de `rows` filtrados/ordenados y, al final, las
  // filas nuevas (siempre visibles). Cursor, edición y cambios siguen usando
  // el índice original; la vista sólo decide qué fila va en cada posición.
  const filtered = useMemo(
    () => computeRowView(columns, rows, rowFilters ?? {}, sort),
    [columns, rows, rowFilters, sort],
  );
  const view = useMemo(
    () => [...filtered, ...inserts.map((_, i) => rows.length + i)],
    [filtered, inserts, rows.length],
  );
  const posOf = useMemo(() => new Map(view.map((row, pos) => [row, pos])), [view]);
  const totalRows = view.length;
  const filtering =
    !!rowFilters && Object.values(rowFilters).some((text) => text.trim() !== "");
  useEffect(() => {
    onShownRowsChange?.(filtering ? filtered.length : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtering, filtered.length]);

  const widthStyle = (colIndex: number): React.CSSProperties | undefined => {
    const w = widths[colIndex];
    return w === undefined ? undefined : { flex: `0 0 ${w}px`, minWidth: w, maxWidth: w };
  };

  /** Arrastra el borde derecho de la cabecera para cambiar el ancho. */
  const startResize = (e: React.MouseEvent, colIndex: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement!;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_COL_WIDTH, Math.round(startW + ev.clientX - startX));
      setColWidths((prev) => ({
        key: colsKey,
        widths: { ...(prev?.key === colsKey ? prev.widths : {}), [colIndex]: w },
      }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-resizing");
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** Doble clic en el borde: vuelve al ancho por defecto. */
  const resetWidth = (colIndex: number) =>
    setColWidths((prev) => {
      const next = { ...(prev?.key === colsKey ? prev.widths : {}) };
      delete next[colIndex];
      return { key: colsKey, widths: next };
    });

  /** Arrastrar una cabecera la mueve a otra posición. */
  const startMove = (e: React.MouseEvent, colIndex: number) => {
    if (e.button !== 0) return;
    const header = (e.currentTarget as HTMLElement).parentElement!;
    const startX = e.clientX;
    let current: { col: number; target: number; after: boolean } | null = null;
    const onMove = (ev: MouseEvent) => {
      if (!current && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return;
      ev.preventDefault();
      // Cabecera bajo el puntero (sólo en horizontal); fuera de todas, la del extremo.
      const ths = Array.from(header.querySelectorAll<HTMLElement>("th[data-col]"));
      if (ths.length === 0) return;
      let hit = ths.find((th) => {
        const r = th.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX < r.right;
      });
      if (!hit) {
        hit = ev.clientX < ths[0].getBoundingClientRect().left ? ths[0] : ths[ths.length - 1];
      }
      const r = hit.getBoundingClientRect();
      current = {
        col: colIndex,
        target: Number(hit.dataset.col),
        after: ev.clientX > r.left + r.width / 2,
      };
      setDrag(current);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-dragging");
      setDrag(null);
      if (!current) return;
      const { col, target, after } = current;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (col === target) return;
      const next = order.filter((i) => i !== col);
      next.splice(next.indexOf(target) + (after ? 1 : 0), 0, col);
      setColOrder({ key: colsKey, order: next });
    };
    document.body.classList.add("col-dragging");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const toggleSort = (col: string) =>
    setSort((prev) =>
      prev?.col !== col
        ? { col, dir: "asc" }
        : prev.dir === "asc"
          ? { col, dir: "desc" }
          : null,
    );
  // Índices (en `columns`) de las columnas visibles según el filtro. El cursor
  // y la edición siguen usando el índice original; sólo cambia qué se pinta.
  const needle = columnFilter.trim().toLowerCase();
  const visibleCols = order.filter(
    (i) => !needle || columns[i].name.toLowerCase().includes(needle),
  );

  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Nueva consulta: el cursor anterior ya no aplica.
  useEffect(() => setCursor(null), [tab.result.queryId]);

  // Mantener la celda activa visible (vertical vía virtualizer, horizontal vía DOM).
  useEffect(() => {
    if (!cursor) return;
    const pos = posOf.get(cursor.row);
    if (pos === undefined) return;
    virtualizer.scrollToIndex(pos, { align: "auto" });
    requestAnimationFrame(() => {
      parentRef.current
        ?.querySelector(`td[data-row="${cursor.row}"][data-col="${cursor.col}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  if (columns.length === 0) return null;

  const cellEditable = (rowIndex: number, colIndex: number) =>
    rowIndex >= rows.length
      ? isInsertCellEditable(editability, colIndex)
      : isCellEditable(editability, rows[rowIndex], colIndex);

  /** Por qué la columna no se puede editar (tooltip), si se sabe. */
  const readOnlyReason = (colIndex: number): string | undefined => {
    if (!editability) return undefined;
    if (!editability.editable) return editability.reason ?? undefined;
    const src = editability.columns[colIndex]?.source;
    return (src && editability.targets[src.target]?.reason) || undefined;
  };

  const cellValue = (rowIndex: number, colIndex: number): DbValue => {
    if (rowIndex >= rows.length) {
      return inserts[rowIndex - rows.length]?.[colIndex] ?? { t: "null" };
    }
    const change = changes[rowIndex];
    if (change?.kind === "update" && colIndex in change.values) {
      return change.values[colIndex];
    }
    return editedValue(editability, edited, rows[rowIndex], colIndex) ?? rows[rowIndex][colIndex];
  };

  /** `typed`: edición iniciada escribiendo; esa tecla reemplaza el valor. */
  const startEdit = (rowIndex: number, colIndex: number, typed?: string) => {
    const insert = rowIndex >= rows.length;
    if (!cellEditable(rowIndex, colIndex)) return;
    const v = cellValue(rowIndex, colIndex);
    setEditing({
      row: rowIndex,
      col: colIndex,
      insert,
      text: typed ?? (v.t === "null" ? "" : dbValueToDisplay(v)),
      selectAll: typed === undefined,
    });
  };

  const commitEdit = () => {
    if (!editing) return;
    if (editing.insert) {
      const insertIndex = editing.row - rows.length;
      const original = inserts[insertIndex]?.[editing.col] ?? { t: "text", v: "" };
      editInsertCell(wsId,
        tab.id,
        insertIndex,
        editing.col,
        displayToDbValue(editing.text, original),
      );
    } else {
      const original = rows[editing.row][editing.col];
      const newValue = displayToDbValue(editing.text, original);
      if (JSON.stringify(newValue) !== JSON.stringify(cellValue(editing.row, editing.col))) {
        editCell(wsId, tab.id, editing.row, editing.col, newValue, original);
        // Otras filas que ya editaron la misma celda real: mismo valor, así
        // no quedan dos ediciones en conflicto.
        const src = editableSource(editability, editing.col);
        const pk = src && pkValues(editability!, src.target, rows[editing.row]);
        if (src && pk) {
          const key = rowKey(src.target, pk);
          for (const [rowStr, change] of Object.entries(changes)) {
            const r = Number(rowStr);
            if (r === editing.row || change.kind !== "update") continue;
            for (const colStr of Object.keys(change.values)) {
              const c = Number(colStr);
              const other = editableSource(editability, c);
              const otherPk = other && pkValues(editability!, other.target, rows[r]);
              if (
                other?.column === src.column &&
                otherPk &&
                rowKey(other.target, otherPk) === key
              ) {
                editCell(wsId, tab.id, r, c, newValue, rows[r][c]);
              }
            }
          }
        }
      }
    }
    setEditing(null);
    parentRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditing(null);
    parentRef.current?.focus();
  };

  /** `row` y `pos`: posiciones en la vista (filas y columnas visibles), no índices originales. */
  const moveTo = (row: number, pos: number) => {
    if (totalRows === 0 || visibleCols.length === 0) return;
    setCursor({
      row: view[Math.max(0, Math.min(totalRows - 1, row))],
      col: visibleCols[Math.max(0, Math.min(visibleCols.length - 1, pos))],
    });
  };

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing || totalRows === 0 || visibleCols.length === 0) return;
    // Posición visible del cursor; si su fila/columna quedó oculta, la primera.
    const cur = {
      row: posOf.get(cursor?.row ?? -1) ?? 0,
      col: Math.max(0, visibleCols.indexOf(cursor?.col ?? -1)),
    };
    // Cursor sobre una fila o columna oculta por los filtros.
    const cursorShown =
      !!cursor && visibleCols.includes(cursor.col) && posOf.has(cursor.row);
    const lastCol = visibleCols.length - 1;
    const mod = e.ctrlKey || e.metaKey;
    const page = Math.max(1, Math.floor((parentRef.current?.clientHeight ?? 260) / ROW_HEIGHT) - 1);
    let handled = true;
    switch (e.key) {
      case "ArrowUp":
        moveTo(mod ? 0 : cur.row - 1, cur.col);
        break;
      case "ArrowDown":
        moveTo(mod ? totalRows - 1 : cur.row + 1, cur.col);
        break;
      case "ArrowLeft":
        moveTo(cur.row, mod ? 0 : cur.col - 1);
        break;
      case "ArrowRight":
        moveTo(cur.row, mod ? lastCol : cur.col + 1);
        break;
      case "Tab":
        // Tab avanza y salta de fila al llegar al final (como una hoja de cálculo).
        if (e.shiftKey) {
          if (cur.col > 0) moveTo(cur.row, cur.col - 1);
          else moveTo(cur.row - 1, lastCol);
        } else if (cur.col < lastCol) moveTo(cur.row, cur.col + 1);
        else moveTo(cur.row + 1, 0);
        break;
      case "Home":
        moveTo(mod ? 0 : cur.row, 0);
        break;
      case "End":
        moveTo(mod ? totalRows - 1 : cur.row, lastCol);
        break;
      case "PageUp":
        moveTo(cur.row - page, cur.col);
        break;
      case "PageDown":
        moveTo(cur.row + page, cur.col);
        break;
      case "Enter":
      case "F2":
        if (cursorShown && cursor) startEdit(cursor.row, cursor.col);
        else moveTo(cur.row, cur.col);
        break;
      case "Escape":
        setCursor(null);
        break;
      default:
        if (mod && e.key.toLowerCase() === "c" && cursorShown && cursor) {
          void navigator.clipboard.writeText(dbValueToDisplay(cellValue(cursor.row, cursor.col)));
        } else if (cursorShown && cursor && !mod && !e.altKey && e.key.length === 1) {
          // Escribir sobre la celda empieza a editarla con esa tecla.
          startEdit(cursor.row, cursor.col, e.key);
        } else {
          handled = false;
        }
    }
    if (handled) e.preventDefault();
  };

  return (
    <div
      className="grid-container"
      ref={parentRef}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
    >
      <table className="results-grid">
        <thead>
          <tr>
            <th className="row-actions-header" />
            {visibleCols.map((colIndex) => {
              const c = columns[colIndex];
              return (
              <th
                key={keys[colIndex]}
                data-col={colIndex}
                className={[
                  "sortable",
                  drag?.col === colIndex ? "col-drag-source" : "",
                  drag && drag.target === colIndex && drag.col !== colIndex
                    ? drag.after ? "col-drop-after" : "col-drop-before"
                    : "",
                ].join(" ")}
                style={widthStyle(colIndex)}
                title={`${c.dbType} — ${t("grid.sortTitle")}`}
                onMouseDown={(e) => startMove(e, colIndex)}
                onClick={() => {
                  if (!suppressClick.current) toggleSort(keys[colIndex]);
                }}
              >
                {c.name}
                {(() => {
                  const src = editability?.columns[colIndex]?.source;
                  return (
                    src &&
                    editability?.targets[src.target]?.pkColumns.includes(src.column) && (
                      <span className="pk-badge">PK</span>
                    )
                  );
                })()}
                {sort?.col === keys[colIndex] && (
                  <span className="sort-indicator">{sort.dir === "asc" ? "▲" : "▼"}</span>
                )}
                <span
                  className="col-resize-handle"
                  title={t("grid.resizeTitle")}
                  onMouseDown={(e) => startResize(e, colIndex)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    resetWidth(colIndex);
                  }}
                />
              </th>
              );
            })}
          </tr>
          {rowFilters && (
            <tr className="filter-row">
              <th className="row-actions-header" />
              {visibleCols.map((colIndex) => (
                <th key={keys[colIndex]} style={widthStyle(colIndex)}>
                  <input
                    value={rowFilters[keys[colIndex]] ?? ""}
                    placeholder={t("grid.rowFilterPlaceholder")}
                    title={t("grid.rowFilterTitle")}
                    onChange={(e) => onRowFilterChange?.(keys[colIndex], e.target.value)}
                    // Que las teclas no lleguen a la navegación del grid.
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const rowIndex = view[virtualRow.index];
            const isInsert = rowIndex >= rows.length;
            const change = changes[rowIndex];
            const deleted = change?.kind === "delete";
            return (
              <tr
                key={virtualRow.key}
                className={[
                  isInsert ? "row-insert" : "",
                  deleted ? "row-deleted" : "",
                  change?.kind === "update" ? "row-changed" : "",
                ].join(" ")}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  height: ROW_HEIGHT,
                }}
              >
                <td className="row-actions">
                  {editability?.rowTarget != null &&
                    (isInsert ? (
                      <button
                        title={t("grid.removeNewRow")}
                        onClick={() => removeInsertRow(wsId, tab.id, rowIndex - rows.length)}
                      >
                        ×
                      </button>
                    ) : (
                      <button
                        title={deleted ? t("grid.restoreRow") : t("grid.markDelete")}
                        onClick={() => toggleDeleteRow(wsId, tab.id, rowIndex)}
                      >
                        {deleted ? "↺" : "−"}
                      </button>
                    ))}
                </td>
                {visibleCols.map((colIndex) => {
                  const isEditing =
                    editing?.row === rowIndex && editing.col === colIndex;
                  const isSelected =
                    cursor?.row === rowIndex && cursor.col === colIndex;
                  const v = cellValue(rowIndex, colIndex);
                  const changed = isInsert
                    ? v.t !== "null"
                    : (change?.kind === "update" && colIndex in change.values) ||
                      editedValue(editability, edited, rows[rowIndex], colIndex) !== undefined;
                  const editable = cellEditable(rowIndex, colIndex);
                  return (
                    <td
                      key={keys[colIndex]}
                      style={widthStyle(colIndex)}
                      className={[
                        v.t === "null" ? "cell-null" : "",
                        changed ? "cell-changed" : "",
                        editable ? "cell-editable" : "",
                        isSelected ? "cell-selected" : "",
                      ].join(" ")}
                      data-row={rowIndex}
                      data-col={colIndex}
                      onMouseDown={() => {
                        if (!isEditing) setCursor({ row: rowIndex, col: colIndex });
                      }}
                      onDoubleClick={() => startEdit(rowIndex, colIndex)}
                      title={editable ? undefined : readOnlyReason(colIndex)}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          onFocus={(e) => {
                            const input = e.currentTarget;
                            if (editing.selectAll) input.select();
                            else input.setSelectionRange(input.value.length, input.value.length);
                          }}
                          value={editing.text}
                          onChange={(e) =>
                            setEditing({ ...editing, text: e.target.value })
                          }
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            // Que las flechas/Enter del input no muevan el cursor del grid.
                            e.stopPropagation();
                            if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") cancelEdit();
                          }}
                        />
                      ) : (
                        dbValueToDisplay(v)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
