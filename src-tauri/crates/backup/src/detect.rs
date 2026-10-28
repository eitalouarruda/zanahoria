use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::version::version_num;

pub const TOOLS: &[&str] = &["pg_dump", "pg_restore", "psql", "mysqldump", "mysql"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
}

impl ToolStatus {
    /// Versión numérica (server_version_num) de la herramienta.
    pub fn version_num(&self) -> Option<u32> {
        self.version.as_deref().and_then(version_num)
    }
}

/// Rutas típicas fuera del PATH donde suelen vivir los binarios de PostgreSQL.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for pattern in [
        "/usr/lib/postgresql/*/bin",
        "/opt/homebrew/opt/postgresql@*/bin",
        "/usr/local/opt/postgresql@*/bin",
    ] {
        if let Some(parent) = std::path::Path::new(pattern)
            .parent()
            .and_then(|p| p.parent())
        {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        dirs.push(bin);
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Ok(entries) = std::fs::read_dir("C:\\Program Files\\PostgreSQL") {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    dirs.push(bin);
                }
            }
        }
    }
    dirs
}

/// Todas las copias de una herramienta: PATH y rutas típicas de instalación
/// (sin duplicados por symlink).
fn find_candidates(name: &str) -> Vec<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let found = which::which_all(name)
        .into_iter()
        .flatten()
        .chain(extra_dirs().into_iter().map(|d| d.join(&exe)))
        .filter(|p| p.is_file());
    for path in found {
        let real = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.insert(real) {
            out.push(path);
        }
    }
    out
}

async fn tool_version(path: &std::path::Path) -> Option<String> {
    let output = tokio::process::Command::new(path)
        .arg("--version")
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    Some(text.lines().next()?.trim().to_string())
}

/// Estado de todas las herramientas, con override manual opcional
/// (`overrides` viene de settings: nombre -> ruta elegida por el usuario).
pub async fn detect_tools(
    overrides: &std::collections::HashMap<String, String>,
) -> Vec<ToolStatus> {
    let mut out = Vec::new();
    for name in TOOLS {
        let manual = overrides
            .get(*name)
            .map(PathBuf::from)
            .filter(|p| p.is_file());
        // Override manual manda; si no, la copia más nueva: un pg_restore
        // nuevo lee archives viejos, pero uno viejo no lee los nuevos, y
        // pg_dump se niega a respaldar servidores más nuevos que él.
        let candidates = match manual {
            Some(p) => vec![p],
            None => find_candidates(name),
        };
        let mut best: Option<(PathBuf, Option<String>)> = None;
        for path in candidates {
            let version = tool_version(&path).await;
            let num = version.as_deref().and_then(version_num).unwrap_or(0);
            let best_num = best
                .as_ref()
                .and_then(|(_, v)| v.as_deref())
                .and_then(version_num)
                .unwrap_or(0);
            if best.is_none() || num > best_num {
                best = Some((path, version));
            }
        }
        let (path, version) = match best {
            Some((p, v)) => (Some(p), v),
            None => (None, None),
        };
        out.push(ToolStatus {
            name: name.to_string(),
            path: path.map(|p| p.display().to_string()),
            version,
        });
    }
    out
}
