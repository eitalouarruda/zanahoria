//! Filtro de compatibilidad para scripts SQL de restore.
//!
//! El pg_restore/pg_dump moderno escribe cosas que un servidor viejo no
//! entiende (`SET transaction_timeout`, `AS integer` en secuencias…), y los
//! dumps de un servidor nuevo usan sintaxis que no existe en uno viejo. El
//! filtro reescribe o descarta esas líneas al vuelo, sin tocar nunca los
//! datos de un bloque `COPY … FROM stdin`.

use std::borrow::Cow;
use std::collections::BTreeMap;

use crate::version::psql_supports_restrict;

/// Parámetros de sesión que pg_dump/pg_restore escriben en la cabecera y la
/// versión de servidor (server_version_num) que los introdujo.
const PG_SET_PARAMS: &[(&str, u32)] = &[
    ("lock_timeout", 90300),
    ("row_security", 90500),
    ("idle_in_transaction_session_timeout", 90600),
    ("default_table_access_method", 120000),
    ("default_toast_compression", 140000),
    ("transaction_timeout", 170000),
];

/// Collations de MySQL 8 que MariaDB y MySQL 5.x no conocen.
const MYSQL_0900_COLLATIONS: &[(&str, &str)] = &[
    ("utf8mb4_0900_ai_ci", "utf8mb4_unicode_ci"),
    ("utf8mb4_0900_as_ci", "utf8mb4_unicode_ci"),
    ("utf8mb4_0900_as_cs", "utf8mb4_bin"),
    ("utf8mb4_0900_bin", "utf8mb4_bin"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dialect {
    Postgres,
    Mysql,
}

#[derive(Debug, Clone)]
pub struct SqlFilter {
    dialect: Dialect,
    /// Versión del servidor destino (server_version_num); 0 = desconocida.
    target: u32,
    /// Versión del psql que ejecuta el script; 0 = desconocida.
    psql: u32,
    /// MySQL: el destino no tiene las collations utf8mb4_0900_*.
    no_0900_collations: bool,
    in_copy: bool,
    /// Correcciones aplicadas (código → veces).
    hits: BTreeMap<String, usize>,
    /// Sentencias CREATE TABLE vistas (para verificar el resultado).
    tables: usize,
    /// Bloques COPY iniciados (progreso: uno por tabla con datos).
    copies: usize,
}

impl SqlFilter {
    pub fn postgres(target: u32, psql: u32) -> Self {
        Self::new(Dialect::Postgres, target, psql, false)
    }

    pub fn mysql(no_0900_collations: bool) -> Self {
        Self::new(Dialect::Mysql, 0, 0, no_0900_collations)
    }

    fn new(dialect: Dialect, target: u32, psql: u32, no_0900_collations: bool) -> Self {
        Self {
            dialect,
            target,
            psql,
            no_0900_collations,
            in_copy: false,
            hits: BTreeMap::new(),
            tables: 0,
            copies: 0,
        }
    }

    /// Códigos de las correcciones que este filtro puede aplicar (para
    /// mostrarlos en el plan antes de restaurar).
    pub fn planned_fixes(&self) -> Vec<String> {
        let mut out = Vec::new();
        match self.dialect {
            Dialect::Postgres => {
                let known = self.target > 0;
                for (param, since) in PG_SET_PARAMS {
                    if known && self.target < *since {
                        out.push(format!("set:{param}"));
                    }
                }
                out.push("create_schema_public".into());
                if known && self.target < 100000 {
                    out.push("sequence_as_type".into());
                }
                if known && self.target < 110000 {
                    out.push("execute_function".into());
                    out.push("index_include".into());
                }
                if known && self.target < 140000 {
                    out.push("pg_database_owner".into());
                }
                if self.psql > 0 && !psql_supports_restrict(self.psql) {
                    out.push("psql_restrict".into());
                }
            }
            Dialect::Mysql => {
                if self.no_0900_collations {
                    out.push("mysql_0900_collation".into());
                }
            }
        }
        out
    }

    /// Correcciones aplicadas de verdad, con cuántas veces.
    pub fn applied(&self) -> &BTreeMap<String, usize> {
        &self.hits
    }

    pub fn tables_seen(&self) -> usize {
        self.tables
    }

    pub fn copies_seen(&self) -> usize {
        self.copies
    }

    fn hit(&mut self, code: &str) {
        *self.hits.entry(code.to_string()).or_default() += 1;
    }

    /// Procesa una línea (con su `\n`). `None` = descartarla.
    pub fn apply<'a>(&mut self, line: &'a [u8]) -> Option<Cow<'a, [u8]>> {
        if self.in_copy {
            if trim_eol(line) == b"\\." {
                self.in_copy = false;
            }
            return Some(Cow::Borrowed(line));
        }
        let body = trim_eol(line);
        if body.starts_with(b"CREATE TABLE ") || body.starts_with(b"CREATE UNLOGGED TABLE ") {
            self.tables += 1;
        }
        match self.dialect {
            Dialect::Postgres => self.apply_pg(line, body),
            Dialect::Mysql => self.apply_mysql(line, body),
        }
    }

    fn apply_pg<'a>(&mut self, line: &'a [u8], body: &[u8]) -> Option<Cow<'a, [u8]>> {
        if body.starts_with(b"COPY ") && body.ends_with(b"FROM stdin;") {
            self.in_copy = true;
            self.copies += 1;
            return Some(Cow::Borrowed(line));
        }
        let known = self.target > 0;

        if let Some(rest) = body.strip_prefix(b"SET ") {
            for (param, since) in PG_SET_PARAMS {
                if known && self.target < *since && starts_with_word(rest, param.as_bytes()) {
                    self.hit(&format!("set:{param}"));
                    return None;
                }
            }
            return Some(Cow::Borrowed(line));
        }

        // Dumps de servidores < 15 recrean el schema public, que ya existe.
        if body == b"CREATE SCHEMA public;" {
            self.hit("create_schema_public");
            if known && self.target < 90300 {
                return None;
            }
            return Some(with_eol(b"CREATE SCHEMA IF NOT EXISTS public;", line));
        }

        // CREATE SEQUENCE … AS integer (PG10+): el tipo es opcional.
        if known && self.target < 100000 && is_sequence_as(body) {
            self.hit("sequence_as_type");
            return None;
        }

        if known && self.target < 110000 {
            if (body.starts_with(b"CREATE TRIGGER ")
                || body.starts_with(b"CREATE CONSTRAINT TRIGGER "))
                && find(body, b" EXECUTE FUNCTION ").is_some()
            {
                self.hit("execute_function");
                return Some(Cow::Owned(replace_once(
                    line,
                    b" EXECUTE FUNCTION ",
                    b" EXECUTE PROCEDURE ",
                )));
            }
            // Índices "covering" (INCLUDE, PG11+): sin las columnas extra el
            // índice/constraint sigue garantizando lo mismo.
            if (body.starts_with(b"CREATE INDEX ")
                || body.starts_with(b"CREATE UNIQUE INDEX ")
                || find(body, b" ADD CONSTRAINT ").is_some())
                && find(body, b" INCLUDE (").is_some()
            {
                if let Some(fixed) = strip_include(line) {
                    self.hit("index_include");
                    return Some(Cow::Owned(fixed));
                }
            }
        }

        // pg_database_owner (PG14+) no existe en servidores viejos: los
        // GRANT/REVOKE/OWNER a ese rol se descartan.
        if known
            && self.target < 140000
            && find(body, b"pg_database_owner").is_some()
            && (body.starts_with(b"GRANT ")
                || body.starts_with(b"REVOKE ")
                || body.starts_with(b"ALTER SCHEMA "))
        {
            self.hit("pg_database_owner");
            return None;
        }

        if self.psql > 0
            && !psql_supports_restrict(self.psql)
            && (body.starts_with(b"\\restrict ") || body.starts_with(b"\\unrestrict "))
        {
            self.hit("psql_restrict");
            return None;
        }

        Some(Cow::Borrowed(line))
    }

    fn apply_mysql<'a>(&mut self, line: &'a [u8], body: &[u8]) -> Option<Cow<'a, [u8]>> {
        if !self.no_0900_collations || body.starts_with(b"INSERT INTO ") {
            return Some(Cow::Borrowed(line));
        }
        let mut out: Option<Vec<u8>> = None;
        for (from, to) in MYSQL_0900_COLLATIONS {
            let current = out.as_deref().unwrap_or(line);
            if find(current, from.as_bytes()).is_some() {
                out = Some(replace_all(current, from.as_bytes(), to.as_bytes()));
            }
        }
        match out {
            Some(v) => {
                self.hit("mysql_0900_collation");
                Some(Cow::Owned(v))
            }
            None => Some(Cow::Borrowed(line)),
        }
    }
}

fn trim_eol(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// `body` reemplazando el contenido de `line` y conservando su fin de línea.
fn with_eol<'a>(body: &[u8], line: &[u8]) -> Cow<'a, [u8]> {
    let eol = &line[trim_eol(line).len()..];
    let mut out = body.to_vec();
    out.extend_from_slice(eol);
    Cow::Owned(out)
}

fn starts_with_word(s: &[u8], word: &[u8]) -> bool {
    s.starts_with(word)
        && s.get(word.len())
            .is_none_or(|c| *c == b' ' || *c == b'=' || *c == b'\t')
}

fn is_sequence_as(body: &[u8]) -> bool {
    let t = body.trim_ascii();
    body.first().is_some_and(|c| *c == b' ' || *c == b'\t')
        && matches!(t, b"AS integer" | b"AS bigint" | b"AS smallint")
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn replace_once(hay: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    match find(hay, from) {
        Some(i) => [&hay[..i], to, &hay[i + from.len()..]].concat(),
        None => hay.to_vec(),
    }
}

fn replace_all(hay: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(hay.len());
    let mut rest = hay;
    while let Some(i) = find(rest, from) {
        out.extend_from_slice(&rest[..i]);
        out.extend_from_slice(to);
        rest = &rest[i + from.len()..];
    }
    out.extend_from_slice(rest);
    out
}

/// Quita ` INCLUDE (…)` respetando paréntesis anidados y comillas dobles.
fn strip_include(line: &[u8]) -> Option<Vec<u8>> {
    let start = find(line, b" INCLUDE (")?;
    let open = start + b" INCLUDE ".len();
    let mut depth = 0usize;
    let mut quoted = false;
    for (i, &c) in line.iter().enumerate().skip(open) {
        match c {
            b'"' => quoted = !quoted,
            b'(' if !quoted => depth += 1,
            b')' if !quoted => {
                depth -= 1;
                if depth == 0 {
                    return Some([&line[..start], &line[i + 1..]].concat());
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(filter: &mut SqlFilter, input: &str) -> String {
        let mut out = Vec::new();
        for line in input.split_inclusive('\n') {
            if let Some(l) = filter.apply(line.as_bytes()) {
                out.extend_from_slice(&l);
            }
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn drops_unknown_settings_for_old_targets() {
        let mut f = SqlFilter::postgres(90624, 180006);
        let out = run(
            &mut f,
            "SET statement_timeout = 0;\nSET transaction_timeout = 0;\nSET lock_timeout = 0;\nSET default_table_access_method = heap;\n",
        );
        assert_eq!(out, "SET statement_timeout = 0;\nSET lock_timeout = 0;\n");
        assert_eq!(f.applied()["set:transaction_timeout"], 1);
    }

    #[test]
    fn keeps_settings_for_new_targets() {
        let mut f = SqlFilter::postgres(180006, 180006);
        let input = "SET transaction_timeout = 0;\nSET default_table_access_method = heap;\n";
        assert_eq!(run(&mut f, input), input);
        assert!(f.applied().is_empty());
    }

    #[test]
    fn create_schema_public_is_idempotent() {
        let mut f = SqlFilter::postgres(90624, 180006);
        assert_eq!(
            run(&mut f, "CREATE SCHEMA public;\r\n"),
            "CREATE SCHEMA IF NOT EXISTS public;\r\n"
        );
    }

    #[test]
    fn downgrade_rewrites() {
        let mut f = SqlFilter::postgres(90624, 180006);
        let input = "CREATE SEQUENCE public.s\n    AS integer\n    START WITH 1;\n\
CREATE TRIGGER t BEFORE INSERT ON public.x FOR EACH ROW EXECUTE FUNCTION public.f();\n\
CREATE UNIQUE INDEX i ON public.x USING btree (a) INCLUDE (b, \"c)\");\n\
GRANT ALL ON SCHEMA public TO pg_database_owner;\n";
        let out = run(&mut f, input);
        assert_eq!(
            out,
            "CREATE SEQUENCE public.s\n    START WITH 1;\n\
CREATE TRIGGER t BEFORE INSERT ON public.x FOR EACH ROW EXECUTE PROCEDURE public.f();\n\
CREATE UNIQUE INDEX i ON public.x USING btree (a);\n"
        );
    }

    #[test]
    fn copy_data_is_untouched() {
        let mut f = SqlFilter::postgres(90624, 90624);
        let input = "COPY public.t (a) FROM stdin;\nSET transaction_timeout = 0;\n    AS integer\n\\.\nSET transaction_timeout = 0;\n";
        assert_eq!(
            run(&mut f, input),
            "COPY public.t (a) FROM stdin;\nSET transaction_timeout = 0;\n    AS integer\n\\.\n"
        );
    }

    #[test]
    fn restrict_dropped_for_old_psql() {
        let mut f = SqlFilter::postgres(150000, 160002);
        assert_eq!(
            run(&mut f, "\\restrict abc\nSELECT 1;\n\\unrestrict abc\n"),
            "SELECT 1;\n"
        );
        let mut f = SqlFilter::postgres(150000, 180006);
        assert_eq!(run(&mut f, "\\restrict abc\n"), "\\restrict abc\n");
    }

    #[test]
    fn counts_tables() {
        let mut f = SqlFilter::postgres(180006, 180006);
        run(&mut f, "CREATE TABLE a (x int);\nCREATE UNLOGGED TABLE b (x int);\nCREATE VIEW v AS SELECT 1;\n");
        assert_eq!(f.tables_seen(), 2);
    }

    #[test]
    fn mysql_collations() {
        let mut f = SqlFilter::mysql(true);
        let out = run(
            &mut f,
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\nINSERT INTO t VALUES ('utf8mb4_0900_ai_ci');\n",
        );
        assert_eq!(
            out,
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\nINSERT INTO t VALUES ('utf8mb4_0900_ai_ci');\n"
        );
    }
}
