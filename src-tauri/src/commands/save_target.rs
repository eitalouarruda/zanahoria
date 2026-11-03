//! Archivo destino elegido en el diálogo de guardado.
//!
//! En desktop es una ruta y se escribe directo. En Android el selector de
//! archivos devuelve una URI `content://`, que `std::fs` no puede abrir: se
//! escribe a un temporal (XLSX necesita una ruta real) y al terminar se copia
//! a la URI a través del plugin fs, que pide el descriptor a Android.

use std::path::{Path, PathBuf};
use std::str::FromStr;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use crate::error::{CmdError, CmdResult};

pub struct SaveTarget {
    /// Donde escriben los sinks.
    local: PathBuf,
    /// URI final (Android); None = `local` ya es el destino.
    uri: Option<String>,
}

impl SaveTarget {
    pub fn new<R: Runtime>(app: &AppHandle<R>, path: &str) -> CmdResult<Self> {
        if !path.contains("://") {
            return Ok(Self {
                local: PathBuf::from(path),
                uri: None,
            });
        }
        let dir = app.path().app_cache_dir().map_err(|e| CmdError {
            message: format!("no cache dir: {e}"),
        })?;
        std::fs::create_dir_all(&dir).map_err(|e| CmdError {
            message: format!("could not create {}: {e}", dir.display()),
        })?;
        Ok(Self {
            local: dir.join(format!("save-{}.tmp", uuid::Uuid::new_v4())),
            uri: Some(path.to_string()),
        })
    }

    /// Ruta real donde escribir.
    pub fn local(&self) -> &Path {
        &self.local
    }

    /// Lleva el archivo escrito a su destino final (no-op en desktop).
    pub fn commit<R: Runtime>(self, app: &AppHandle<R>) -> std::io::Result<()> {
        let Some(uri) = &self.uri else {
            return Ok(());
        };
        let result = (|| {
            let dest = FilePath::from_str(uri).map_err(std::io::Error::other)?;
            let mut opts = OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            let mut out = app.fs().open(dest, opts)?;
            let mut src = std::fs::File::open(&self.local)?;
            std::io::copy(&mut src, &mut out)?;
            out.sync_all()
        })();
        let _ = std::fs::remove_file(&self.local);
        result
    }

    /// Borra lo escrito tras un error o una cancelación.
    pub fn discard(self) {
        let _ = std::fs::remove_file(&self.local);
    }
}
