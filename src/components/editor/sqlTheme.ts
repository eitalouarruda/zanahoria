import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Engine } from "../../ipc/types";

/**
 * Paleta "TablePlus Dark" (ColorSchemeService.create_default_dark_theme de
 * TablePlus Linux 0.1.316). Cada color va a un style id de GtkSourceView:
 * def:comment, def:decimal, def:string, custom-sql:*-quoted-string,
 * def:keyword, custom-sql:current-query, selection (fondo) y text.
 */
export const TABLEPLUS_DARK = {
  comment: "#009B31",
  number: "#B57AFF",
  string: "#CA6E6E",
  backtickIdent: "#E04978",
  doubleQuotedIdent: "#F9B746",
  bracketIdent: "#B72720",
  keyword: "#529BD8",
  currentQuery: "#FFFFFF",
  selection: "#476287",
  text: "#C0C0C0",
} as const;

const P = TABLEPLUS_DARK;

/**
 * lang-sql etiqueta igual (special(string)) los identificadores entre
 * backticks y entre comillas dobles; el dialecto decide cuál aplica.
 * TablePlus los colorea distinto, así que se elige por engine.
 */
function highlightStyle(engine: Engine) {
  const quotedIdent =
    engine === "mysql" || engine === "mariadb" ? P.backtickIdent : P.doubleQuotedIdent;
  return HighlightStyle.define([
    { tag: [t.lineComment, t.blockComment, t.comment], color: P.comment, fontStyle: "italic" },
    { tag: [t.number, t.null], color: P.number },
    { tag: t.string, color: P.string },
    { tag: t.special(t.string), color: quotedIdent },
    { tag: [t.keyword, t.bool, t.typeName], color: P.keyword },
    { tag: t.special(t.name), color: P.doubleQuotedIdent },
    { tag: [t.name, t.standard(t.name), t.operator, t.punctuation], color: P.text },
  ]);
}

const editorTheme = EditorView.theme(
  {
    "&": { color: P.text, backgroundColor: "var(--bg)" },
    ".cm-content": { caretColor: "#ffffff" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#ffffff" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: P.selection },
    ".cm-gutters": {
      backgroundColor: "var(--bg)",
      color: "var(--fg-dim)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: P.text },
    // Statement bajo el cursor (custom-sql:current-query, blanco con alpha bajo).
    ".cm-current-statement": { backgroundColor: "rgba(255, 255, 255, 0.045)" },
    ".cm-matchingBracket": {
      backgroundColor: "rgba(82, 155, 216, 0.25)",
      outline: "1px solid rgba(82, 155, 216, 0.5)",
    },
    ".cm-nonmatchingBracket": { color: "var(--red)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(71, 98, 135, 0.45)" },
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
      backgroundColor: P.selection,
      color: "#ffffff",
    },
    ".cm-completionDetail": { color: "var(--fg-dim)", fontStyle: "normal", marginLeft: "1em" },
    ".cm-completionMatchedText": { textDecoration: "none", color: P.doubleQuotedIdent },
  },
  { dark: true },
);

export function sqlTheme(engine: Engine) {
  return [editorTheme, syntaxHighlighting(highlightStyle(engine))];
}
