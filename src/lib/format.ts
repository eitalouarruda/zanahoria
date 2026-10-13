import { format as sqlFormat } from "sql-formatter";
import type { Engine } from "../ipc/types";

const LANGUAGE: Record<Engine, string> = {
  postgres: "postgresql",
  mysql: "mysql",
  mariadb: "mariadb",
  sqlite: "sqlite",
  redis: "sql",
};

/** Beautify de la query (Ctrl+I). */
export function beautify(sql: string, engine: Engine): string {
  try {
    return sqlFormat(sql, {
      language: LANGUAGE[engine] as never,
      keywordCase: "upper",
      tabWidth: 2,
    });
  } catch {
    return sql;
  }
}

/**
 * Uglify (Ctrl+Shift+I): deja la query en una sola línea. Colapsa espacios
 * fuera de strings/identificadores y convierte `-- comentario` en
 * `/* comentario *\/` para que no se coma el resto de la línea.
 */
export function uglify(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      const text = sql.slice(i + 2, end).trim().replace(/\*\//g, "* /");
      if (text) out += `/* ${text} */ `;
      i = end;
    } else if (/\s/.test(c)) {
      while (i < n && /\s/.test(sql[i])) i++;
      if (out && !out.endsWith(" ")) out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out.trim();
}
