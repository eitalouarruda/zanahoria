use serde::{Deserialize, Serialize};

/// Valor de celda serializable a través del IPC. El tag preserva el tipo para
/// que el grid pueda editar y regenerar SQL sin pérdida.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "snake_case")]
pub enum DbValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    /// Decimales como string para no perder precisión.
    Decimal(String),
    Text(String),
    /// Binario en base64.
    Bytes(String),
    Json(serde_json::Value),
    /// Fechas/horas en ISO-8601 como string.
    Date(String),
    Time(String),
    Timestamp(String),
    Uuid(String),
}

impl DbValue {
    pub fn is_null(&self) -> bool {
        matches!(self, DbValue::Null)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub db_type: String,
}

pub type Row = Vec<DbValue>;
