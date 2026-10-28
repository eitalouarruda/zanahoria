import type { Engine } from "../../ipc/types";

/** 1536 → "1.5 KB". */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Número de versión de un texto: "18.6 (Debian…)" → "18.6", "pg_dump (PostgreSQL) 18.6" → "18.6". */
export function versionLabel(text: string): string {
  return text.match(/\d+(\.\d+)+/)?.[0] ?? text.match(/\d+/)?.[0] ?? text;
}

/**
 * Nombre propuesto para la database nueva de un restore. Se prefiere el
 * nombre del archivo (el usuario suele nombrarlo con sentido) sin fechas ni
 * palabras como "backup"; si no queda nada, la database de origen.
 * Nunca repite una database existente.
 */
export function suggestDbName(
  sourceDb: string | null,
  path: string,
  existing: string[],
): string {
  const file = path.split(/[\\/]/).pop() ?? "";
  const stem = file.replace(/(\.(dump|sql|gz|backup|bak|tar|custom|pgdump|zip))+$/i, "");
  const fromFile = sanitize(
    stem
      .replace(/\d{4}[-_.]?\d{2}[-_.]?\d{2}([-_ T]?\d{2}[-_:.]?\d{2}([-_:.]?\d{2})?)?/g, " ")
      .replace(/\b(backup|bkp|dump|db_dump|pg_dump)\b/gi, " ")
      .replace(/(^|[_-])(backup|bkp|dump)(?=[_-]|$)/gi, " "),
  );
  const base = fromFile || sanitize(sourceDb ?? "") || "restored";
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

function sanitize(s: string): string {
  const clean = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return /^\d/.test(clean) ? `db_${clean}` : clean;
}

/** Nombre por defecto del archivo de respaldo: "ventas_2026-10-28_0930.dump". */
export function defaultBackupName(
  db: string,
  engine: Engine,
  format: string,
  now = new Date(),
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const ext = engine === "sqlite" ? "sqlite" : engine === "postgres" && format === "custom" ? "dump" : "sql";
  return `${sanitize(db) || "backup"}_${stamp}.${ext}`;
}

export interface ResultInfo {
  /** Clave i18n del texto explicativo. */
  code: string;
  params: Record<string, string | number>;
  /** Última línea de error de la salida (para mostrarla tal cual). */
  lastError: string | null;
  /** El fallo se reconoció y tiene explicación propia. */
  known: boolean;
}

/** Fallos frecuentes → explicación en lenguaje llano (orden = prioridad). */
const KNOWN_FAILURES: [RegExp, string][] = [
  [/unsupported version \([\d.]+\) in file header/, "bk.err.tooNew"],
  [/is older than the server|server version mismatch/, "bk.err.dumpTooOld"],
  [/password authentication failed|no password supplied/, "bk.err.auth"],
  [/could not connect|Connection refused|could not translate host name/, "bk.err.connect"],
  [/No space left on device/, "bk.err.disk"],
  [/role "[^"]+" does not exist/, "bk.err.role"],
  [/already exists/, "bk.err.exists"],
  [/permission denied/i, "bk.err.permission"],
  [/tables expected/, "bk.err.missingTables"],
  [/incomplete|cannot be read back|not recognized/, "bk.err.badFile"],
];

const isErrorLine = (l: string) => /ERROR:|error:|^ERROR /.test(l);

/** Explica el resultado de un job a partir de su mensaje final y su salida. */
export function explainResult(
  log: string[],
  result: { success: boolean; message: string },
): ResultInfo {
  const { message } = result;
  if (result.success) {
    let m = message.match(/(\d+) tables expected, (\d+) found/);
    if (m) return { code: "bk.ok.tables", params: { n: m[2] }, lastError: null, known: true };
    m = message.match(/backup verified: (\d+) tables/);
    if (m) return { code: "bk.ok.backupTables", params: { n: m[1] }, lastError: null, known: true };
    if (/dump is complete/.test(message)) {
      return { code: "bk.ok.backupComplete", params: {}, lastError: null, known: true };
    }
    return { code: "bk.ok.generic", params: {}, lastError: null, known: true };
  }
  if (message === "cancelled") {
    return { code: "bk.err.cancelled", params: {}, lastError: null, known: true };
  }
  const lastError = [...log].reverse().find(isErrorLine) ?? null;
  const text = [...log, message].join("\n");
  for (const [re, code] of KNOWN_FAILURES) {
    if (re.test(text)) return { code, params: {}, lastError, known: true };
  }
  const m = message.match(/completed with (\d+) errors/);
  if (m) return { code: "bk.err.someErrors", params: { n: m[1] }, lastError, known: true };
  return { code: "bk.err.generic", params: {}, lastError: lastError ?? message, known: false };
}
