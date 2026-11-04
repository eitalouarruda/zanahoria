use crate::{error::CmdResult, runtime::AppHandle};
use std::path::{Path, PathBuf};
pub struct SaveTarget {
    path: PathBuf,
}
impl SaveTarget {
    pub fn new(app: &AppHandle, path: &str) -> CmdResult<Self> {
        Ok(Self {
            path: app.file_path(path)?,
        })
    }
    pub fn local(&self) -> &Path {
        &self.path
    }
    pub fn commit(self, _app: &AppHandle) -> std::io::Result<()> {
        Ok(())
    }
    pub fn discard(self) {
        let _ = std::fs::remove_file(self.path);
    }
}
