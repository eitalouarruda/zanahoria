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
        return Ok(SniffResult {
            kind,
            compressed: false,
            restore_tool: (kind == DumpKind::PgDirectory).then(|| "pg_restore".into()),
            note: match kind {
                DumpKind::PgDirectory => "PostgreSQL directory-format dump".into(),
                _ => "directory without toc.dat".into(),
            },
        });
    }

    let mut file = std::fs::File::open(p)?;
    let mut header = vec![0u8; 4096];
    let n = file.read(&mut header)?;
    header.truncate(n);

    let compressed = header.starts_with(&[0x1f, 0x8b]);
    let kind = if compressed {
        let mut decoder = flate2::read::GzDecoder::new(std::fs::File::open(p)?);
        let mut inner = vec![0u8; 4096];
        let n = decoder.read(&mut inner).unwrap_or(0);
        inner.truncate(n);
        classify(&inner)
    } else {
        classify(&header)
    };

    let (restore_tool, note) = match kind {
        DumpKind::PgCustom => (Some("pg_restore"), "PostgreSQL custom-format dump"),
        DumpKind::PgTar => (Some("pg_restore"), "PostgreSQL tar-format dump"),
        DumpKind::PgDirectory => (Some("pg_restore"), "PostgreSQL directory-format dump"),
        DumpKind::PlainSql => (Some("psql"), "plain SQL script"),
        DumpKind::Unknown => (None, "unrecognized format"),
    };
    Ok(SniffResult {
        kind,
        compressed,
        restore_tool: restore_tool.map(String::from),
        note: if compressed {
            format!("{note} (gzip)")
        } else {
            note.to_string()
        },
    })
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

    #[test]
    fn unknown_binary() {
        let r = sniff_bytes(&[0x00, 0x01, 0x02, 0x03]);
        assert_eq!(r.kind, DumpKind::Unknown);
    }
}
