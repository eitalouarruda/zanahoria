import { useEffect, useMemo, useRef } from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleBlockComment,
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
import { sqlTheme } from "./sqlTheme";
import { sqlLanguage, completionRecencyTracker } from "./sqlCompletion";
import { currentStatementHighlight, currentStatementText } from "./currentStatement";

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
}

interface Props {
  value: string;
  engine: Engine;
  schema: DbSchema | null;
  onChange: (value: string) => void;
  /**
   * Ejecutar: recibe la selección o el statement bajo el cursor (Mod-Enter),
   * undefined = todo el texto (Mod-Shift-Enter).
   */
  onRun: (selection?: string) => void;
  apiRef?: React.MutableRefObject<EditorApi | null>;
}

function selectedText(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return from === to ? "" : view.state.sliceDoc(from, to);
}

function fontTheme(size: number) {
  return EditorView.theme({
    "&": { height: "100%", fontSize: `${size}px` },
    ".cm-scroller": { fontFamily: "'JetBrains Mono', 'Fira Code', monospace" },
  });
}

export default function SqlEditor({ value, engine, schema, onChange, onRun, apiRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const fontCompartment = useRef(new Compartment());
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  onRunRef.current = onRun;
  onChangeRef.current = onChange;

  const fontSize = useSettings((s) => s.editorFontSize);

  const langExtension = useMemo(
    () => [sqlLanguage(DIALECTS[engine], engine, schema), sqlTheme(engine)],
    [engine, schema],
  );

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
        autocompletion({ activateOnTypingDelay: 50, icons: true }),
        completionRecencyTracker,
        keymap.of([
          // Como TablePlus: Mod-Enter ejecuta la selección o, si no hay,
          // el statement bajo el cursor; Mod-Shift-Enter ejecuta todo.
          {
            key: "Mod-Enter",
            run: (view) => {
              const text = selectedText(view) || currentStatementText(view);
              if (text.trim()) onRunRef.current(text);
              return true;
            },
          },
          {
            key: "Mod-Shift-Enter",
            run: () => {
              onRunRef.current(undefined);
              return true;
            },
          },
          // Comentario de bloque (Ctrl+/ de línea ya viene en defaultKeymap).
          { key: "Mod-Alt-/", run: toggleBlockComment },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        langCompartment.current.of(langExtension),
        fontCompartment.current.of(fontTheme(useSettings.getState().editorFontSize)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    if (apiRef) {
      apiRef.current = { getSelection: () => selectedText(view) };
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

  return <div className="sql-editor" ref={containerRef} />;
}
