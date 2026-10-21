//! db-core: motor de acceso a bases de datos, independiente de Tauri.
//! Drivers puros en Rust (sqlx + redis con rustls) para compatibilidad con Android.

pub mod analyze;
pub mod config;
pub mod driver;
pub mod engines;
pub mod error;
mod exec;
pub mod mutation;
pub mod pool;
pub mod schema;
pub mod value;

pub use analyze::{analyze_query, dangerous_statements, is_read_only, Editability};
pub use config::{ConnectionConfig, Engine};
pub use driver::{
    Capabilities, ExecEvent, ExecOpts, ExecSummary, MutationResult, MutationStatement, QueryStream,
};
pub use engines::EngineHandle;
pub use error::{DbError, ErrorPosition, Result};
pub use mutation::{build_mutations, ChangeKind, PendingChange};
pub use pool::PoolManager;
pub use schema::{Column, DbSchema, Namespace, Table, TableKind};
pub use value::{ColumnMeta, DbValue, Row};
