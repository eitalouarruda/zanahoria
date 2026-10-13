import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Engine } from "../../ipc/types";
import type { ResolvedTheme } from "../../lib/theme";

/** Colores de sintaxis por tema. */
interface Palette {
  comment: string;
  number: string;
  string: string;
  /** Identificadores entre backticks (MySQL/MariaDB). */
  backtickIdent: string;
  /** Identificadores entre comillas dobles (Postgres/SQLite). */
  doubleQuotedIdent: string;
  keyword: string;
  text: string;
  selection: string;
  caret: string;
  /** Fondo del statement bajo el cursor. */
  currentStatement: string;
  activeLine: string;
}

const PALETTES: Record<ResolvedTheme, Palette> = {
  dark: {
    comment: "#009B31",
    number: "#B57AFF",
    string: "#CA6E6E",
    backtickIdent: "#E04978",
    doubleQuotedIdent: "#F9B746",
    keyword: "#529BD8",
    text: "#C0C0C0",
    selection: "#476287",
    caret: "#ffffff",
    currentStatement: "rgba(255, 255, 255, 0.045)",
    activeLine: "rgba(255, 255, 255, 0.03)",
  },
  light: {
    comment: "#009B31",
    number: "#1D00FF",
    string: "#E04978",
    backtickIdent: "#B72720",
    doubleQuotedIdent: "#D78B17",
    keyword: "#2F6FB0",
    text: "#1f2328",
    selection: "#A5CDFF",
    caret: "#000000",
    currentStatement: "rgba(0, 0, 0, 0.04)",
    activeLine: "rgba(0, 0, 0, 0.03)",
  },
};

/**
 * lang-sql etiqueta igual (special(string)) los identificadores entre
 * backticks y entre comillas dobles; el dialecto decide cuál aplica, así que
 * el color se elige por engine.
 */
function highlightStyle(engine: Engine, p: Palette) {
  const quotedIdent =
    engine === "mysql" || engine === "mariadb" ? p.backtickIdent : p.doubleQuotedIdent;
  return HighlightStyle.define([
    { tag: [t.lineComment, t.blockComment, t.comment], color: p.comment, fontStyle: "italic" },
    { tag: [t.number, t.null], color: p.number },
    { tag: t.string, color: p.string },
    { tag: t.special(t.string), color: quotedIdent },
    { tag: [t.keyword, t.bool, t.typeName], color: p.keyword },
    { tag: t.special(t.name), color: p.doubleQuotedIdent },
    { tag: [t.name, t.standard(t.name), t.operator, t.punctuation], color: p.text },
  ]);
}

function editorTheme(mode: ResolvedTheme, p: Palette) {
  return EditorView.theme(
    {
      "&": { color: p.text, backgroundColor: "var(--bg)" },
      ".cm-content": { caretColor: p.caret },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.caret },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: p.selection },
      ".cm-gutters": {
        backgroundColor: "var(--bg)",
        color: "var(--fg-dim)",
        border: "none",
      },
      ".cm-activeLine": { backgroundColor: p.activeLine },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: p.text },
      ".cm-current-statement": { backgroundColor: p.currentStatement },
      ".cm-matchingBracket": {
        backgroundColor: "rgba(82, 155, 216, 0.25)",
        outline: "1px solid rgba(82, 155, 216, 0.5)",
      },
      ".cm-nonmatchingBracket": { color: "var(--red)" },
      ".cm-selectionMatch": { backgroundColor: "rgba(82, 155, 216, 0.22)" },
      ".cm-searchMatch": { backgroundColor: "rgba(249, 183, 70, 0.25)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(249, 183, 70, 0.5)" },
      ".cm-panels": { backgroundColor: "var(--bg-panel)", color: "var(--fg)" },
      ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-panel)",
        border: "1px solid var(--border)",
        color: "var(--fg)",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: p.selection,
        color: mode === "dark" ? "#ffffff" : "#000000",
      },
      ".cm-completionDetail": { color: "var(--fg-dim)", fontStyle: "normal", marginLeft: "1em" },
      ".cm-completionMatchedText": { textDecoration: "none", color: p.doubleQuotedIdent },
    },
    { dark: mode === "dark" },
  );
}

export function sqlTheme(engine: Engine, mode: ResolvedTheme) {
  const p = PALETTES[mode];
  return [editorTheme(mode, p), syntaxHighlighting(highlightStyle(engine, p))];
}
