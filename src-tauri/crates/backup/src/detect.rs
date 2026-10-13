use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const TOOLS: &[&str] = &["pg_dump", "pg_restore", "psql", "mysqldump", "mysql"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
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

fn find_tool(name: &str) -> Option<PathBuf> {
    if let Ok(path) = which::which(name) {
        return Some(path);
    }
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    extra_dirs()
        .into_iter()
        .map(|d| d.join(&exe))
        .find(|p| p.is_file())
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
        let path = overrides
            .get(*name)
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .or_else(|| find_tool(name));
        let version = match &path {
            Some(p) => tool_version(p).await,
            None => None,
        };
        out.push(ToolStatus {
            name: name.to_string(),
            path: path.map(|p| p.display().to_string()),
            version,
        });
    }
    out
}
