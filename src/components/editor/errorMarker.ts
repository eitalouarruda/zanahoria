import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** Marca (o limpia, con null) la posición de un error de query. */
export const setErrorMarker = StateEffect.define<number | null>();

const lineDeco = Decoration.line({ class: "cm-error-line" });
const markDeco = Decoration.mark({ class: "cm-error-mark" });

/** Rango a subrayar: la palabra en `pos`, o un carácter si no hay palabra. */
function markRange(state: EditorState, pos: number): { from: number; to: number } | null {
  const len = state.doc.length;
  if (len === 0) return null;
  const word = state.wordAt(Math.min(pos, len));
  if (word && word.from <= pos && word.from < word.to) return word;
  const line = state.doc.lineAt(Math.min(pos, len));
  if (pos < line.to) return { from: pos, to: pos + 1 };
  // Al final de la línea (o del documento): el carácter anterior.
  return pos > line.from ? { from: pos - 1, to: pos } : null;
}

function build(state: EditorState, pos: number): DecorationSet {
  const at = Math.min(pos, state.doc.length);
  const line = state.doc.lineAt(at);
  const range = markRange(state, at);
  const decos = [lineDeco.range(line.from)];
  if (range) decos.push(markDeco.range(range.from, range.to));
  return Decoration.set(decos, true);
}

/** Resalta la línea y el token del error; desaparece al editar el texto. */
export const errorMarker = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorMarker)) return e.value === null ? Decoration.none : build(tr.state, e.value);
    }
    return tr.docChanged ? Decoration.none : decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});
