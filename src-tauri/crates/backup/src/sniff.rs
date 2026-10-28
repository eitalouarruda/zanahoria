use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DumpKind {
    /// pg_dump -Fc (magic PGDMP) → pg_restore
    PgCustom,
    /// pg_dump -Ft → pg_restore
    PgTar,
    /// pg_dump -Fd (directorio con toc.dat) → pg_restore
    PgDirectory,
    /// SQL plano (pg_dump/mysqldump/cualquier herramienta) → psql / mysql
    PlainSql,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SniffResult {
    pub kind: DumpKind,
    pub compressed: bool,
    /// Herramienta sugerida para restaurar (pg_restore | psql | mysql).
    pub restore_tool: Option<String>,
    pub note: String,
    /// Versión del formato de archive de pg_dump (custom/tar/directory), "1.16".
    pub archive_version: Option<String>,
    /// Engine de origen cuando se puede deducir ("postgres" | "mysql" | "mariadb").
    pub source_engine: Option<String>,
    /// Versión del servidor de origen ("9.0.5", "15.4 (Debian…)", "8.0.36").
    pub source_version: Option<String>,
    /// Versión de la herramienta que generó el dump (pg_dump/mysqldump).
    pub dumped_by: Option<String>,
    /// Nombre de la database de origen.
    pub source_db: Option<String>,
    /// Tamaño del archivo en bytes (None para dumps en directorio).
    pub size: Option<u64>,
}

/// Metadatos que se pueden leer del dump sin herramientas externas.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Meta {
    archive: Option<(u8, u8)>,
    engine: Option<&'static str>,
    source_version: Option<String>,
    dumped_by: Option<String>,
    source_db: Option<String>,
}

/// Lee la cabecera de un archive de pg_dump (formato custom, o el toc.dat
/// de tar/directory): versión del archive, database y versiones de origen.
/// Funciona aunque el pg_restore instalado sea demasiado viejo para leerlo.
fn parse_pgdmp(buf: &[u8]) -> Option<Meta> {
    let rest = buf.strip_prefix(b"PGDMP")?;
    let (&vmaj, rest) = rest.split_first()?;
    let (&vmin, rest) = rest.split_first()?;
    let (_vrev, rest) = rest.split_first()?;
    let (&int_size, rest) = rest.split_first()?;
    let (_off_size, rest) = rest.split_first()?;
    let (_format, mut rest) = rest.split_first()?;
    let version = (vmaj, vmin);
    let mut meta = Meta {
        archive: Some(version),
        engine: Some("postgres"),
        ..Meta::default()
    };

    let read_int = |rest: &mut &[u8]| -> Option<i64> {
        // 1 byte de signo + int_size bytes little-endian.
        let n = 1 + int_size as usize;
        if rest.len() < n || int_size as usize > 8 {
            return None;
        }
        let (bytes, tail) = rest.split_at(n);
        *rest = tail;
        let mut v: i64 = 0;
        for (i, b) in bytes[1..].iter().enumerate() {
            v |= (*b as i64) << (8 * i);
        }
        Some(if bytes[0] != 0 { -v } else { v })
    };
    let read_str = |rest: &mut &[u8]| -> Option<Option<String>> {
        let len = read_int(rest)?;
        if len < 0 {
            return Some(None);
        }
        let len = len as usize;
        if rest.len() < len {
            return None;
        }
        let (bytes, tail) = rest.split_at(len);
        *rest = tail;
        Some(Some(String::from_utf8_lossy(bytes).into_owned()))
    };

    // Compresión: desde 1.15 un byte (algoritmo), antes un int (nivel).
    if version >= (1, 15) {
        rest = rest.get(1..)?;
    } else {
        read_int(&mut rest)?;
    }
    // Fecha de creación: 7 ints (struct tm).
    for _ in 0..7 {
        read_int(&mut rest)?;
    }
    meta.source_db = read_str(&mut rest).flatten();
    if version >= (1, 10) {
        meta.source_version = read_str(&mut rest).flatten();
        meta.dumped_by = read_str(&mut rest).flatten();
    }
    Some(meta)
}

/// Comentarios de cabecera de un dump SQL plano (pg_dump / mysqldump).
fn parse_sql_header(text: &str) -> Meta {
    let mut meta = Meta::default();
    for line in text.lines().take(80) {
        let line = line.trim_end();
        if let Some(v) = line.strip_prefix("-- Dumped from database version ") {
            meta.engine = Some("postgres");
            meta.source_version = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("-- Dumped by pg_dump version ") {
            meta.engine = Some("postgres");
            meta.dumped_by = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("-- Server version") {
            let v = v.trim().to_string();
            if meta.engine != Some("postgres") {
                meta.engine = Some(if v.to_lowercase().contains("mariadb") {
                    "mariadb"
                } else {
                    "mysql"
                });
            }
            meta.source_version = Some(v);
        } else if line.starts_with("-- MySQL dump") || line.starts_with("-- MariaDB dump") {
            meta.dumped_by = Some(line.trim_start_matches("-- ").to_string());
            meta.engine.get_or_insert(if line.contains("MariaDB") {
                "mariadb"
            } else {
                "mysql"
            });
        } else if let Some(pos) = line.find("Database: ") {
            if line.starts_with("-- Host:") {
                let db = line[pos + "Database: ".len()..].trim();
                if !db.is_empty() {
                    meta.source_db = Some(db.to_string());
                }
            }
        }
    }
    meta
}

fn classify(header: &[u8]) -> DumpKind {
    if header.starts_with(b"PGDMP") {
        return DumpKind::PgCustom;
    }
    // tar: "ustar" en offset 257
    if header.len() > 262 && &header[257..262] == b"ustar" {
        return DumpKind::PgTar;
    }
    let text = String::from_utf8_lossy(&header[..header.len().min(2048)]);
    let looks_sql = text.lines().take(30).any(|line| {
        let l = line.trim_start().to_uppercase();
        l.starts_with("--")
            || l.starts_with("SET ")
            || l.starts_with("BEGIN")
            || l.starts_with("CREATE ")
            || l.starts_with("INSERT ")
            || l.starts_with("DROP ")
            || l.starts_with("/*")
    });
    if looks_sql {
        DumpKind::PlainSql
    } else {
        DumpKind::Unknown
    }
}

/// Identifica el formato de un dump para elegir la herramienta de restore
/// automáticamente (pg_restore para custom/tar/directory, psql/mysql para
/// SQL plano; gzip se descomprime la cabecera para clasificar el contenido).
pub fn sniff_dump(path: &str) -> Result<SniffResult> {
    let p = Path::new(path);

    if p.is_dir() {
        let kind = if p.join("toc.dat").is_file() {
            DumpKind::PgDirectory
        } else {
            DumpKind::Unknown
        };
        let meta = std::fs::read(p.join("toc.dat"))
            .ok()
            .and_then(|toc| parse_pgdmp(&toc[..toc.len().min(8192)]))
            .unwrap_or_default();
        return Ok(result(
            kind,
            false,
            (kind == DumpKind::PgDirectory).then_some("pg_restore"),
            match kind {
                DumpKind::PgDirectory => "PostgreSQL directory-format dump".into(),
                _ => "directory without toc.dat".into(),
            },
            meta,
        ));
    }

    let mut file = std::fs::File::open(p)?;
    let mut header = Vec::new();
    (&mut file).take(8192).read_to_end(&mut header)?;

    let compressed = header.starts_with(&[0x1f, 0x8b]);
    let content = if compressed {
        let mut decoder = flate2::read::MultiGzDecoder::new(std::fs::File::open(p)?);
        let mut inner = Vec::new();
        let _ = (&mut decoder).take(8192).read_to_end(&mut inner);
        inner
    } else {
        header
    };
    let kind = classify(&content);
    let meta = match kind {
        DumpKind::PgCustom => parse_pgdmp(&content).unwrap_or_default(),
        // tar: el primer miembro es toc.dat, con su contenido desde el byte 512.
        DumpKind::PgTar => content.get(512..).and_then(parse_pgdmp).unwrap_or_default(),
        DumpKind::PlainSql => parse_sql_header(&String::from_utf8_lossy(&content)),
        _ => Meta::default(),
    };

    let (restore_tool, note) = match kind {
        DumpKind::PgCustom => (Some("pg_restore"), "PostgreSQL custom-format dump"),
        DumpKind::PgTar => (Some("pg_restore"), "PostgreSQL tar-format dump"),
        DumpKind::PgDirectory => (Some("pg_restore"), "PostgreSQL directory-format dump"),
        DumpKind::PlainSql if matches!(meta.engine, Some("mysql" | "mariadb")) => {
            (Some("mysql"), "MySQL/MariaDB SQL dump")
        }
        DumpKind::PlainSql => (Some("psql"), "plain SQL script"),
        DumpKind::Unknown => (None, "unrecognized format"),
    };
    let note = if compressed {
        format!("{note} (gzip)")
    } else {
        note.to_string()
    };
    let mut r = result(kind, compressed, restore_tool, note, meta);
    r.size = std::fs::metadata(p).ok().map(|m| m.len());
    Ok(r)
}

fn result(
    kind: DumpKind,
    compressed: bool,
    restore_tool: Option<&str>,
    note: String,
    meta: Meta,
) -> SniffResult {
    SniffResult {
        kind,
        compressed,
        restore_tool: restore_tool.map(String::from),
        note,
        archive_version: meta.archive.map(|(a, b)| format!("{a}.{b}")),
        source_engine: meta.engine.map(String::from),
        source_version: meta.source_version,
        dumped_by: meta.dumped_by,
        source_db: meta.source_db,
        size: None,
    }
}

impl SniffResult {
    /// Versión del archive como tupla comparable.
    pub fn archive(&self) -> Option<(u8, u8)> {
        let (a, b) = self.archive_version.as_deref()?.split_once('.')?;
        Some((a.parse().ok()?, b.parse().ok()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn sniff_bytes(bytes: &[u8]) -> SniffResult {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(bytes).unwrap();
        sniff_dump(f.path().to_str().unwrap()).unwrap()
    }

    #[test]
    fn detects_pg_custom() {
        let r = sniff_bytes(b"PGDMP\x01\x0e\x00rest-of-dump");
        assert_eq!(r.kind, DumpKind::PgCustom);
        assert_eq!(r.restore_tool.as_deref(), Some("pg_restore"));
    }

    #[test]
    fn detects_tar() {
        let mut bytes = vec![0u8; 512];
        bytes[257..262].copy_from_slice(b"ustar");
        let r = sniff_bytes(&bytes);
        assert_eq!(r.kind, DumpKind::PgTar);
    }

    #[test]
    fn detects_plain_sql() {
        let r = sniff_bytes(b"--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;\n");
        assert_eq!(r.kind, DumpKind::PlainSql);
        assert_eq!(r.restore_tool.as_deref(), Some("psql"));
    }

    #[test]
    fn detects_gzipped_sql() {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder
            .write_all(b"-- MySQL dump 10.13\nCREATE TABLE t (id int);\n")
            .unwrap();
        let r = sniff_bytes(&encoder.finish().unwrap());
        assert!(r.compressed);
        assert_eq!(r.kind, DumpKind::PlainSql);
    }

    #[test]
    fn detects_pg_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("toc.dat"), b"PGDMP...").unwrap();
        let r = sniff_dump(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(r.kind, DumpKind::PgDirectory);
    }

    /// Cabecera custom real (pg_dump 9.0.5, archive 1.12, int de 4 bytes).
    fn pgdmp_header(vmin: u8, dbname: &str, remote: &str, by: &str) -> Vec<u8> {
        let int = |v: i64| {
            let mut b = vec![(v < 0) as u8];
            b.extend_from_slice(&(v.unsigned_abs() as u32).to_le_bytes());
            b
        };
        let s = |v: &str| [int(v.len() as i64), v.as_bytes().to_vec()].concat();
        let mut out = b"PGDMP".to_vec();
        out.extend_from_slice(&[1, vmin, 0, 4, 8, 1]);
        if vmin >= 15 {
            out.push(1);
        } else {
            out.extend(int(-1));
        }
        for v in [55, 21, 9, 28, 9, 126, 0] {
            out.extend(int(v));
        }
        out.extend(s(dbname));
        out.extend(s(remote));
        out.extend(s(by));
        out
    }

    #[test]
    fn reads_custom_header_metadata() {
        let r = sniff_bytes(&pgdmp_header(12, "athos", "9.0.5", "9.0.5"));
        assert_eq!(r.kind, DumpKind::PgCustom);
        assert_eq!(r.archive_version.as_deref(), Some("1.12"));
        assert_eq!(r.archive(), Some((1, 12)));
        assert_eq!(r.source_db.as_deref(), Some("athos"));
        assert_eq!(r.source_version.as_deref(), Some("9.0.5"));

        let r = sniff_bytes(&pgdmp_header(16, "nt", "18.3 (Debian)", "18.3"));
        assert_eq!(r.archive_version.as_deref(), Some("1.16"));
        assert_eq!(r.source_version.as_deref(), Some("18.3 (Debian)"));
        assert_eq!(r.dumped_by.as_deref(), Some("18.3"));
    }

    #[test]
    fn reads_plain_sql_metadata() {
        let r = sniff_bytes(
            b"--\n-- PostgreSQL database dump\n--\n\n-- Dumped from database version 15.4\n-- Dumped by pg_dump version 16.10\nSET x = 1;\n",
        );
        assert_eq!(r.source_engine.as_deref(), Some("postgres"));
        assert_eq!(r.source_version.as_deref(), Some("15.4"));
        assert_eq!(r.dumped_by.as_deref(), Some("16.10"));

        let r = sniff_bytes(
            b"-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)\n--\n-- Host: localhost    Database: shop\n-- ------\n-- Server version\t8.0.36\n",
        );
        assert_eq!(r.source_engine.as_deref(), Some("mysql"));
        assert_eq!(r.source_version.as_deref(), Some("8.0.36"));
        assert_eq!(r.source_db.as_deref(), Some("shop"));
    }

    #[test]
    fn unknown_binary() {
        let r = sniff_bytes(&[0x00, 0x01, 0x02, 0x03]);
        assert_eq!(r.kind, DumpKind::Unknown);
    }
}
