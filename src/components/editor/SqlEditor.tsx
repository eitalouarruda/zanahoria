import { useEffect, useMemo, useRef } from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  type KeyBinding,
} from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { PostgreSQL, MySQL, SQLite, StandardSQL, type SQLDialect } from "@codemirror/lang-sql";
import type { DbSchema, Engine } from "../../ipc/types";
import { useSettings } from "../../stores/settingsStore";
import { keysFor, type ActionId } from "../../lib/keymap";
import { useResolvedTheme } from "../../lib/theme";
import { sqlTheme } from "./sqlTheme";
import { sqlLanguage, completionRecencyTracker } from "./sqlCompletion";
import { currentStatementHighlight, currentStatementText } from "./currentStatement";
import { statementAt } from "./statements";
import { errorMarker, setErrorMarker } from "./errorMarker";

const DIALECTS: Record<Engine, SQLDialect> = {
  postgres: PostgreSQL,
  mysql: MySQL,
  mariadb: MySQL,
  sqlite: SQLite,
  redis: StandardSQL,
};

export interface EditorApi {
  /** Texto seleccionado actualmente (vacío si no hay selección). */
  getSelection: () => string;
  /** Offset donde empieza la selección actual. */
  selectionFrom: () => number;
  /** Mueve el cursor a `offset`, lo hace visible y enfoca el editor. */
  goTo: (offset: number) => void;
  /** Lleva el foco al editor (cursor donde estaba). */
  focus: () => void;
}

interface Props {
  value: string;
  engine: Engine;
  schema: DbSchema | null;
  onChange: (value: string) => void;
  /**
   * Ejecutar: recibe la selección o el statement bajo el cursor (Mod-Enter),
   * undefined = todo el texto (Mod-Shift-Enter). `from` = offset de la selección.
   */
  onRun: (selection?: string, from?: number) => void;
  /** Offset del último error de query a marcar (null = ninguno). */
  errorAt?: number | null;
  apiRef?: React.MutableRefObject<EditorApi | null>;
}

function selectedText(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return from === to ? "" : view.state.sliceDoc(from, to);
}

/** Comentar línea/bloque vienen de los atajos configurables, no de los defaults de CM. */
const baseKeymap = defaultKeymap.filter(
  (b) => b.run !== toggleComment && b.run !== toggleBlockComment,
);

/**
 * Atajos del editor que dependen de la vista (ejecutar, comentar). Salen del
 * registro de acciones; solo se usan combinaciones de un paso.
 */
function actionKeymap(
  overrides: Partial<Record<ActionId, string[]>>,
  onRun: () => (selection?: string, from?: number) => void,
): KeyBinding[] {
  const bind = (action: ActionId, run: KeyBinding["run"]): KeyBinding[] =>
    keysFor(action, overrides)
      .filter((k) => !k.includes(" "))
      .map((key) => ({ key, run }));
  return [
    // Selección o, si no hay, el statement bajo el cursor.
    ...bind("runCurrent", (view) => {
      const sel = selectedText(view);
      if (sel) {
        if (sel.trim()) onRun()(sel, view.state.selection.main.from);
        return true;
      }
      const text = currentStatementText(view);
      const range = statementAt(view.state.doc.toString(), view.state.selection.main.head);
      if (text.trim()) onRun()(text, range?.from);
      return true;
    }),
    ...bind("runAll", () => {
      onRun()(undefined);
      return true;
    }),
    ...bind("toggleComment", toggleComment),
    ...bind("toggleBlockComment", toggleBlockComment),
  ];
}

/**
 * WebKitGTK (Tauri en Linux): tras pegar, CodeMirror actualiza su estado y
 * dibuja el cursor al final de lo pegado, pero la selección nativa del DOM se
 * queda donde estaba y lo siguiente que se tipea cae antes del texto pegado.
 * Tras cada paste se vuelve a fijar la selección nativa en la del estado.
 */
const resyncSelectionAfterPaste = EditorView.updateListener.of((update) => {
  if (!update.transactions.some((tr) => tr.isUserEvent("input.paste"))) return;
  const view = update.view;
  requestAnimationFrame(() => {
    const main = view.state.selection.main;
    const sel = document.getSelection();
    if (!sel || !view.hasFocus || !main.empty) return;
    const { node, offset } = view.domAtPos(main.head);
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  });
});

function fontTheme(size: number) {
  return EditorView.theme({
    "&": { height: "100%", fontSize: `${size}px` },
    ".cm-scroller": { fontFamily: "'JetBrains Mono', 'Fira Code', monospace" },
  });
}

export default function SqlEditor({
  value,
  engine,
  schema,
  onChange,
  onRun,
  apiRef,
  errorAt = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const fontCompartment = useRef(new Compartment());
  const keysCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  onRunRef.current = onRun;
  onChangeRef.current = onChange;

  const fontSize = useSettings((s) => s.editorFontSize);
  const shortcuts = useSettings((s) => s.shortcuts);
  const theme = useResolvedTheme();

  const langExtension = useMemo(
    () => sqlLanguage(DIALECTS[engine], engine, schema),
    [engine, schema],
  );
  const themeExtension = useMemo(() => sqlTheme(engine, theme), [engine, theme]);
  const getOnRun = () => onRunRef.current;

  useEffect(() => {
    if (!containerRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        currentStatementHighlight,
        errorMarker,
        autocompletion({ activateOnTypingDelay: 50, icons: true }),
        completionRecencyTracker,
        keysCompartment.current.of(
          keymap.of(actionKeymap(useSettings.getState().shortcuts, getOnRun)),
        ),
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...baseKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        langCompartment.current.of(langExtension),
        themeCompartment.current.of(themeExtension),
        fontCompartment.current.of(fontTheme(useSettings.getState().editorFontSize)),
        resyncSelectionAfterPaste,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    if (apiRef) {
      apiRef.current = {
        getSelection: () => selectedText(view),
        selectionFrom: () => view.state.selection.main.from,
        goTo: (offset) => {
          const pos = Math.min(offset, view.state.doc.length);
          view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
          view.focus();
        },
        focus: () => view.focus(),
      };
    }
    return () => {
      view.destroy();
      viewRef.current = null;
      if (apiRef) apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigurar dialect/schema sin recrear el editor.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: langCompartment.current.reconfigure(langExtension),
    });
  }, [langExtension]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(themeExtension),
    });
  }, [themeExtension]);

  // Atajos redefinidos en Settings.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: keysCompartment.current.reconfigure(keymap.of(actionKeymap(shortcuts, getOnRun))),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcuts]);

  // Font size (Ctrl +/- o settings).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: fontCompartment.current.reconfigure(fontTheme(fontSize)),
    });
  }, [fontSize]);

  // Sincronizar cambios externos (beautify, abrir favorita).
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }
  }, [value]);

  // Marcar el error de la última ejecución (o limpiarlo).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setErrorMarker.of(errorAt) });
    if (errorAt !== null) {
      view.dispatch({
        effects: EditorView.scrollIntoView(Math.min(errorAt, view.state.doc.length), {
          y: "nearest",
        }),
      });
    }
  }, [errorAt]);

  return <div className="sql-editor" ref={containerRef} />;
}
