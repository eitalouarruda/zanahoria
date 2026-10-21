import type { SavedConnection } from "../ipc/types";

/** Texto donde se busca: nombre, grupo, motor, usuario, host y database. */
function haystack(c: SavedConnection): string {
  return [c.name, c.group ?? "", c.engine, c.user, c.host, c.port ?? "", c.database]
    .join(" ")
    .toLowerCase();
}

/**
 * True si la conexión contiene todas las palabras del filtro (sin importar
 * mayúsculas ni el orden). Un filtro vacío deja pasar todo.
 */
export function matchesConnection(c: SavedConnection, filter: string): boolean {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(c);
  return terms.every((t) => text.includes(t));
}
