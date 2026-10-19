import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DbValue } from "../../ipc/types";
import { dbValueToDisplay, displayToDbValue } from "../../ipc/types";
import { useWorkspaces, type QueryTab } from "../../stores/workspaceStore";
import { useT } from "../../i18n";

interface Props {
  /** Id del workspace en el store. */
  wsId: string;
  tab: QueryTab;
  /** Filtro de columnas por nombre (parcial, sin distinguir mayúsculas). */
  columnFilter?: string;
}

const ROW_HEIGHT = 26;

export default function ResultsGrid({ wsId, tab, columnFilter = "" }: Props) {
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

  const { columns, rows, editability, changes, inserts } = tab.result;
  const totalRows = rows.length + inserts.length;
  // Índices (en `columns`) de las columnas visibles según el filtro. El cursor
  // y la edición siguen usando el índice original; sólo cambia qué se pinta.
  const needle = columnFilter.trim().toLowerCase();
  const visibleCols = columns
    .map((_, i) => i)
    .filter((i) => !needle || columns[i].name.toLowerCase().includes(needle));

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
    virtualizer.scrollToIndex(cursor.row, { align: "auto" });
    requestAnimationFrame(() => {
      parentRef.current
        ?.querySelector(`td[data-row="${cursor.row}"][data-col="${cursor.col}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  if (columns.length === 0) return null;

  const isColEditable = (colName: string) =>
    editability?.editable && editability.columnSources[colName] != null;

  const cellValue = (rowIndex: number, colIndex: number): DbValue => {
    const colName = columns[colIndex].name;
    if (rowIndex >= rows.length) {
      return inserts[rowIndex - rows.length]?.[colName] ?? { t: "null" };
    }
    const change = changes[rowIndex];
    if (change?.kind === "update" && colName in change.values) {
      return change.values[colName];
    }
    return rows[rowIndex][colIndex];
  };

  /** `typed`: edición iniciada escribiendo; esa tecla reemplaza el valor. */
  const startEdit = (rowIndex: number, colIndex: number, typed?: string) => {
    const colName = columns[colIndex].name;
    const insert = rowIndex >= rows.length;
    if (!insert && !isColEditable(colName)) return;
    if (insert && !editability?.editable) return;
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
    const colName = columns[editing.col].name;
    if (editing.insert) {
      const insertIndex = editing.row - rows.length;
      const original = inserts[insertIndex]?.[colName] ?? { t: "text", v: "" };
      editInsertCell(wsId,
        tab.id,
        insertIndex,
        colName,
        displayToDbValue(editing.text, original),
      );
    } else {
      const original = rows[editing.row][editing.col];
      const newValue = displayToDbValue(editing.text, original);
      if (JSON.stringify(newValue) !== JSON.stringify(cellValue(editing.row, editing.col))) {
        editCell(wsId, tab.id, editing.row, colName, newValue, original);
      }
    }
    setEditing(null);
    parentRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditing(null);
    parentRef.current?.focus();
  };

  /** `pos`: posición dentro de las columnas visibles, no índice original. */
  const moveTo = (row: number, pos: number) => {
    if (totalRows === 0 || visibleCols.length === 0) return;
    setCursor({
      row: Math.max(0, Math.min(totalRows - 1, row)),
      col: visibleCols[Math.max(0, Math.min(visibleCols.length - 1, pos))],
    });
  };

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing || totalRows === 0 || visibleCols.length === 0) return;
    // Posición visible del cursor; si su columna quedó oculta, la primera.
    const cur = { row: cursor?.row ?? 0, col: Math.max(0, visibleCols.indexOf(cursor?.col ?? -1)) };
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
        if (cursor && visibleCols.includes(cursor.col)) startEdit(cursor.row, cursor.col);
        else moveTo(cur.row, cur.col);
        break;
      case "Escape":
        setCursor(null);
        break;
      default:
        if (mod && e.key.toLowerCase() === "c" && cursor && visibleCols.includes(cursor.col)) {
          void navigator.clipboard.writeText(dbValueToDisplay(cellValue(cursor.row, cursor.col)));
        } else if (cursor && visibleCols.includes(cursor.col) && !mod && !e.altKey && e.key.length === 1) {
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
            {visibleCols.map((colIndex) => columns[colIndex]).map((c) => (
              <th key={c.name} title={c.dbType}>
                {c.name}
                {editability?.pkColumns.includes(
                  editability.columnSources[c.name] ?? "",
                ) && <span className="pk-badge">PK</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const rowIndex = virtualRow.index;
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
                  {editability?.editable &&
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
                  const c = columns[colIndex];
                  const isEditing =
                    editing?.row === rowIndex && editing.col === colIndex;
                  const isSelected =
                    cursor?.row === rowIndex && cursor.col === colIndex;
                  const v = cellValue(rowIndex, colIndex);
                  const changed =
                    (change?.kind === "update" && c.name in change.values) ||
                    (isInsert && v.t !== "null");
                  return (
                    <td
                      key={c.name}
                      className={[
                        v.t === "null" ? "cell-null" : "",
                        changed ? "cell-changed" : "",
                        isColEditable(c.name) || isInsert ? "cell-editable" : "",
                        isSelected ? "cell-selected" : "",
                      ].join(" ")}
                      data-row={rowIndex}
                      data-col={colIndex}
                      onMouseDown={() => {
                        if (!isEditing) setCursor({ row: rowIndex, col: colIndex });
                      }}
                      onDoubleClick={() => startEdit(rowIndex, colIndex)}
                      title={
                        !editability?.editable && editability?.reason
                          ? editability.reason
                          : undefined
                      }
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
