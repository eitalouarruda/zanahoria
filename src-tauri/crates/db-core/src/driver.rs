use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

use crate::error::Result;
use crate::value::{ColumnMeta, DbValue, Row};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub sql: bool,
    pub transactions: bool,
    pub multiple_databases: bool,
    pub backup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOpts {
    /// Filas antes de pausar el cursor y avisar `truncated` (0 = sin límite).
    pub max_rows: usize,
    pub chunk_size: usize,
}

impl Default for ExecOpts {
    fn default() -> Self {
        Self {
            max_rows: 10_000,
            chunk_size: 500,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecSummary {
    /// Filas afectadas por statements que no devuelven filas.
    pub affected: Option<u64>,
    /// true si el cursor sigue vivo y hay más filas (usar fetch_more).
    pub truncated: bool,
    pub total_rows: u64,
}

/// Eventos emitidos durante la ejecución de una query.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecEvent {
    Columns { columns: Vec<ColumnMeta> },
    Rows { rows: Vec<Row> },
    Done { summary: ExecSummary },
}

/// Handle de una query en ejecución con streaming de chunks.
pub struct QueryStream {
    pub events: mpsc::Receiver<Result<ExecEvent>>,
    pub cancel: CancellationToken,
    /// Notificar para continuar tras un Done { truncated: true }.
    pub resume: Arc<Notify>,
}

/// Statement de mutación: `sql` parametrizado + params, con el SQL interpolado
/// solo para mostrar en el Code Preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationStatement {
    pub sql: String,
    pub params: Vec<DbValue>,
    pub preview_sql: String,
    /// Si Some, se verifica affected_rows == expected y si no, rollback.
    pub expected_rows: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub affected_total: u64,
    pub statements_run: usize,
}
