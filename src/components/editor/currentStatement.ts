import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { statementAt } from "./statements";

const lineDeco = Decoration.line({ class: "cm-current-statement" });

/** Texto del statement bajo el cursor ("" si no hay ninguno). */
export function currentStatementText(view: EditorView): string {
  const doc = view.state.doc.toString();
  const range = statementAt(doc, view.state.selection.main.head);
  return range ? doc.slice(range.from, range.to) : "";
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  // Sin resaltado con selección activa o con un único statement (no aporta).
  if (!state.selection.main.empty) return builder.finish();
  const doc = state.doc.toString();
  const range = statementAt(doc, state.selection.main.head);
  if (!range || (range.from === 0 && doc.slice(range.to).trim().replace(/^;/, "").trim() === "")) {
    return builder.finish();
  }
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  for (let n = first; n <= last; n++) {
    builder.add(state.doc.line(n).from, state.doc.line(n).from, lineDeco);
  }
  return builder.finish();
}

/** Resalta las líneas del statement bajo el cursor (TablePlus: highlight current query). */
export const currentStatementHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) this.decorations = build(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);
