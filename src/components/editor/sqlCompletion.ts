import { LanguageSupport } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import {
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import {
  keywordCompletionSource,
  schemaCompletionSource,
  type SQLDialect,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import type { DbSchema, Engine, Table } from "../../ipc/types";
import { statementAt } from "./statements";

// ---- Recencia: lo elegido antes sube en la lista ----

const RECENT_KEY = "zanahoria.completion.recent";
const RECENT_MAX = 200;

function loadRecent(): Map<string, number> {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw) return new Map(JSON.parse(raw) as [string, number][]);
  } catch {
    // sin storage: solo en memoria
  }
  return new Map();
}

const recent = loadRecent();

function recordPick(label: string) {
  recent.set(label, (recent.get(label) ?? 0) + 1);
  if (recent.size > RECENT_MAX) {
    const weakest = [...recent.entries()].sort((a, b) => a[1] - b[1]).slice(0, recent.size - RECENT_MAX);
    for (const [k] of weakest) recent.delete(k);
  }
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([...recent.entries()]));
  } catch {
    // ignorar
  }
}

function recencyBoost(label: string): number {
  const n = recent.get(label);
  return n ? Math.min(20, 4 + n * 2) : 0;
}

/** Registra cada completion aceptada para el boost por recencia. */
export const completionRecencyTracker = EditorView.updateListener.of((update) => {
  for (const tr of update.transactions) {
    const picked = tr.annotation(pickedCompletion);
    if (picked) recordPick(picked.label);
  }
});

function withRecency(source: CompletionSource): CompletionSource {
  return async (ctx) => {
    const res = await source(ctx);
    if (!res) return res;
    return {
      ...res,
      options: res.options.map((o) => {
        const b = recencyBoost(o.label);
        return b ? { ...o, boost: (o.boost ?? 0) + b } : o;
      }),
    };
  };
}

// ---- Schema para lang-sql ----

function columnCompletions(table: Table): Completion[] {
  return table.columns.map((c) => ({
    label: c.name,
    type: "property",
    detail: c.isPk ? `${c.dbType} · PK` : c.dbType,
  }));
}

function defaultNamespace(engine: Engine, schema: DbSchema | null): string | undefined {
  if (!schema || schema.namespaces.length === 0) return undefined;
  if (engine === "postgres" && schema.namespaces.some((n) => n.name === "public")) return "public";
  return schema.namespaces.length === 1 ? schema.namespaces[0].name : undefined;
}

function langSqlSchema(schema: DbSchema | null): SQLNamespace {
  const out: { [ns: string]: { [table: string]: Completion[] } } = {};
  if (!schema) return out;
  for (const ns of schema.namespaces) {
    const tables: { [table: string]: Completion[] } = {};
    for (const table of ns.tables) tables[table.name] = columnCompletions(table);
    out[ns.name] = tables;
  }
  return out;
}

// ---- Columnas de las tablas usadas en el statement actual ----

interface TableRef {
  namespace: string | null;
  table: string;
  alias: string | null;
}

const IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
const NOT_ALIAS = new Set([
  "where", "join", "inner", "left", "right", "full", "outer", "cross", "on", "using",
  "group", "order", "limit", "offset", "having", "union", "set", "values", "natural",
  "window", "returning", "lateral", "fetch", "for", "into", "select",
]);

function unquote(s: string): string {
  const t = s.trim();
  if (/^["`[]/.test(t)) return t.slice(1, -1);
  return t;
}

/** Quita strings y comentarios para que no generen falsos positivos. */
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

export function tableRefs(statement: string): TableRef[] {
  const sql = stripNoise(statement);
  const refs: TableRef[] = [];
  const itemRe = new RegExp(String.raw`^\s*(${QUALIFIED})(?:\s+(?:as\s+)?(${IDENT}))?`, "i");
  const headRe = /\b(from|join|update|into)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(sql))) {
    let rest = sql.slice(m.index + m[0].length);
    // FROM admite lista separada por comas: FROM a x, b y
    for (;;) {
      const item = itemRe.exec(rest);
      if (!item) break;
      const parts = item[1].split(/\s*\.\s*/).map(unquote);
      const alias = item[2] && !NOT_ALIAS.has(item[2].toLowerCase()) ? unquote(item[2]) : null;
      refs.push({
        namespace: parts.length > 1 ? parts[0] : null,
        table: parts[parts.length - 1],
        alias,
      });
      rest = rest.slice(item[0].length);
      if (m[1].toLowerCase() !== "from" || !/^\s*,/.test(rest)) break;
      rest = rest.replace(/^\s*,/, "");
    }
  }
  return refs;
}

function findTable(schema: DbSchema, ref: TableRef): Table | null {
  const name = ref.table.toLowerCase();
  for (const ns of schema.namespaces) {
    if (ref.namespace && ns.name.toLowerCase() !== ref.namespace.toLowerCase()) continue;
    const t = ns.tables.find((x) => x.name.toLowerCase() === name);
    if (t) return t;
  }
  return null;
}

function contextColumnSource(getSchema: () => DbSchema | null): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const schema = getSchema();
    if (!schema) return null;
    const word = ctx.matchBefore(/[\w$]+/);
    // Columnas calificadas (alias.col) las resuelve schemaCompletionSource.
    const charBefore = ctx.state.sliceDoc((word?.from ?? ctx.pos) - 1, word?.from ?? ctx.pos);
    if (charBefore === ".") return null;
    if (!word && !ctx.explicit) return null;

    const doc = ctx.state.doc.toString();
    const range = statementAt(doc, ctx.pos);
    if (!range) return null;
    const refs = tableRefs(doc.slice(range.from, Math.max(range.to, ctx.pos)));
    if (refs.length === 0) return null;

    const options: Completion[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const table = findTable(schema, ref);
      if (!table) continue;
      const owner = ref.alias ?? table.name;
      for (const col of table.columns) {
        const key = `${owner}.${col.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({
          label: col.name,
          type: "property",
          detail: `${col.dbType} · ${owner}`,
          // Por encima de keywords/tablas: es lo más probable dentro del statement.
          boost: 10 + recencyBoost(col.name),
        });
      }
    }
    if (options.length === 0) return null;
    return { from: word?.from ?? ctx.pos, options, validFor: /^[\w$]*$/ };
  };
}

/**
 * Soporte SQL con completado contextual: keywords, tablas y
 * columnas con tipo, columnas de las tablas del statement actual sin
 * calificar, y boost por uso reciente.
 */
export function sqlLanguage(
  dialect: SQLDialect,
  engine: Engine,
  schema: DbSchema | null,
): LanguageSupport {
  const config = {
    dialect,
    schema: langSqlSchema(schema),
    defaultSchema: defaultNamespace(engine, schema),
    upperCaseKeywords: true,
  };
  const data = dialect.language.data;
  return new LanguageSupport(dialect.language, [
    data.of({ autocomplete: withRecency(schemaCompletionSource(config)) }),
    data.of({ autocomplete: withRecency(keywordCompletionSource(dialect, true)) }),
    data.of({ autocomplete: contextColumnSource(() => schema) }),
  ]);
}
