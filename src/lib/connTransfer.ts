import type { ConnectionConfig, SavedConnection } from "../ipc/types";
import { normalizeGroup } from "../stores/connectionsStore";

/**
 * Exportar/importar conexiones. El backend produce paquetes cifrados
 * `ZNH1.<base64url>`; acá se reparten en varios QR cuando no entran en uno y
 * se vuelven a juntar al escanear.
 */

/** Prefijo de un paquete completo (ver `app_store::transfer`). */
export const TOKEN_PREFIX = "ZNH1.";
/** Prefijo de una parte de QR: `ZNHP.<i>.<n>.<set>.<trozo>` (i desde 1). */
const PART_PREFIX = "ZNHP.";
/**
 * Caracteres por QR. Una conexión entra en uno; con más, partes de este
 * tamaño (QR ~versión 15, nivel M) se leen bien desde una pantalla, también
 * con la webcam o una captura.
 */
export const QR_CHUNK = 450;

const TOKEN_RE = /^ZNH1\.[A-Za-z0-9_-]+$/;
const PART_RE = /^ZNHP\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)\.(.+)$/s;

/**
 * Paquetes completos dentro de un texto (archivo .txt o texto pegado). Cada
 * paquete empieza con `ZNH1.`; las líneas siguientes sin prefijo son su
 * continuación (texto cortado por un editor o un chat).
 */
export function extractTokens(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/\s+/g, "");
    if (!clean || line.trimStart().startsWith("#")) continue;
    const at = clean.indexOf(TOKEN_PREFIX);
    if (at >= 0) found.push(clean.slice(at));
    else if (found.length > 0) found[found.length - 1] += clean;
  }
  return [...new Set(found.filter((t) => TOKEN_RE.test(t)))];
}

/** Contenido del .txt exportado: comentarios + el paquete. */
export function exportFileText(token: string, count: number, date = new Date()): string {
  return [
    "# Zanahoria — encrypted connections export",
    `# ${count} connection(s) · ${date.toISOString().slice(0, 10)}`,
    "# Import it in Zanahoria → Connections → Import, using the passphrase chosen on export.",
    token,
    "",
  ].join("\n");
}

/** Textos a mostrar como QR: el paquete solo, o partes numeradas. */
export function splitForQr(token: string, size = QR_CHUNK): string[] {
  if (token.length <= size) return [token];
  // Id del juego de partes: tramo aleatorio del salt, para no mezclar exports.
  const set = token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 8);
  const n = Math.ceil(token.length / size);
  return Array.from(
    { length: n },
    (_, i) => `${PART_PREFIX}${i + 1}.${n}.${set}.${token.slice(i * size, (i + 1) * size)}`,
  );
}

/** Estado de una lectura de QR en varias partes. */
export interface ScanProgress {
  set: string | null;
  total: number;
  parts: Record<number, string>;
}

export const emptyScan = (): ScanProgress => ({ set: null, total: 0, parts: {} });

export type ScanResult =
  | { kind: "token"; token: string; progress: ScanProgress }
  | { kind: "partial"; progress: ScanProgress }
  | { kind: "invalid"; progress: ScanProgress };

/**
 * Suma un QR leído. Un paquete entero termina enseguida; una parte se acumula
 * hasta tener todas (en cualquier orden; repetidas no cuentan). Una parte de
 * otro export reinicia la lectura.
 */
export function addScan(progress: ScanProgress, text: string): ScanResult {
  const content = text.trim();
  const part = PART_RE.exec(content);
  if (!part) {
    const [token] = extractTokens(content);
    return token
      ? { kind: "token", token, progress: emptyScan() }
      : { kind: "invalid", progress };
  }
  const [, i, n, set, chunk] = part;
  const index = Number(i);
  const total = Number(n);
  if (index < 1 || index > total) return { kind: "invalid", progress };
  const next: ScanProgress =
    progress.set === set && progress.total === total
      ? { ...progress, parts: { ...progress.parts, [index]: chunk } }
      : { set, total, parts: { [index]: chunk } };
  if (Object.keys(next.parts).length < total) return { kind: "partial", progress: next };
  const token = Array.from({ length: total }, (_, k) => next.parts[k + 1]).join("");
  return { kind: "token", token, progress: emptyScan() };
}

/** Partes que faltan (números desde 1), para mostrarlas al usuario. */
export function missingParts(progress: ScanProgress): number[] {
  return Array.from({ length: progress.total }, (_, k) => k + 1).filter(
    (i) => !(i in progress.parts),
  );
}

export interface ImportItem {
  config: ConnectionConfig;
  /** Ya existe una conexión con el mismo id: se reemplaza. */
  replaces: boolean;
  /** El grupo no existe todavía en este dispositivo: se crea. */
  newGroup: boolean;
}

/**
 * Prepara las conexiones descifradas para guardarlas. El grupo viaja con la
 * conexión: si acá ya hay uno con ese nombre (sin distinguir mayúsculas) se
 * usa ese, si no se crea al guardar.
 */
export function planImport(
  incoming: ConnectionConfig[],
  saved: SavedConnection[],
  groups: string[],
): ImportItem[] {
  const existingIds = new Set(saved.map((c) => c.id));
  const byKey = new Map(groups.map((g) => [g.toLocaleLowerCase(), g]));
  const created = new Set<string>();
  const seen = new Map<string, ImportItem>();
  for (const raw of incoming) {
    const wanted = normalizeGroup(raw.group);
    const key = wanted?.toLocaleLowerCase();
    let group = key ? byKey.get(key) : undefined;
    if (wanted && key && !group) {
      // Las demás conexiones del mismo grupo nuevo usan el mismo nombre.
      group = wanted;
      byKey.set(key, wanted);
      created.add(key);
    }
    seen.set(raw.id, {
      config: { ...raw, group: group ?? null },
      replaces: existingIds.has(raw.id),
      newGroup: !!key && created.has(key),
    });
  }
  return [...seen.values()];
}
