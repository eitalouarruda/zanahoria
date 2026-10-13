//! backup: respaldos y restauración vía binarios del sistema (desktop only).
//! Detecta pg_dump/pg_restore/psql/mysqldump/mysql en PATH (+ rutas típicas),
//! identifica automáticamente el formato de un dump y ejecuta los procesos
//! con streaming de su salida.

mod detect;
mod runner;
mod sniff;

pub use detect::{detect_tools, ToolStatus};
pub use runner::{
    build_backup_command, build_restore_command, run_job, BackupOptions, JobHandle, JobLine,
    JobSpec, RestoreOptions,
};
pub use sniff::{sniff_dump, DumpKind, SniffResult};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum BackupError {
    #[error("tool not found: {0}")]
    ToolNotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

pub type Result<T, E = BackupError> = std::result::Result<T, E>;
