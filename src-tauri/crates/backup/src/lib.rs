//! backup: respaldos y restauración vía binarios del sistema (desktop only).
//! Detecta pg_dump/pg_restore/psql/mysqldump/mysql en PATH (+ rutas típicas),
//! identifica el formato y las versiones de origen de un dump, planifica el
//! restore según la versión del servidor destino y ejecuta los procesos con
//! streaming de su salida (pasando el SQL por un filtro de compatibilidad
//! cuando hace falta).

mod compat;
mod detect;
mod plan;
mod runner;
mod sniff;
pub mod version;

pub use compat::SqlFilter;
pub use detect::{detect_tools, ToolStatus};
pub use plan::{plan_restore, PlanNote, RestorePlan, Strategy, TargetInfo};
pub use runner::{
    archive_toc, build_backup_command, build_restore_command, run_job, verify_backup,
    BackupOptions, Feed, JobHandle, JobLine, JobSpec, JobStats, Progress, RestoreOptions,
    TocCounts,
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
