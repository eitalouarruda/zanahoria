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
    /// Fechas/horas en ISO-8601 como string. Los timestamps con zona llevan
    /// offset (`+00:00`); los sin zona no, para no compararlos como timestamptz.
    Date(String),
    Time(String),
    Timestamp(String),
    Uuid(String),
}

impl DbValue {
    pub fn is_null(&self) -> bool {
        matches!(self, DbValue::Null)
    }

    /// Timestamp sin zona (`timestamp`/`DATETIME`): ISO-8601 sin offset.
    pub fn naive_timestamp(v: chrono::NaiveDateTime) -> Self {
        DbValue::Timestamp(v.format("%Y-%m-%dT%H:%M:%S%.f").to_string())
    }
}

/// true si el timestamp ISO-8601 lleva zona (`Z`, `+hh:mm`, `-hh:mm`).
pub fn timestamp_has_offset(s: &str) -> bool {
    let s = s.trim();
    if s.ends_with('Z') || s.ends_with('z') {
        return true;
    }
    // El offset va después de la hora; el '-' de la fecha no cuenta.
    let time = s.rfind([' ', 'T']).map_or("", |i| &s[i + 1..]);
    time.contains(['+', '-'])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub db_type: String,
}

pub type Row = Vec<DbValue>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naive_timestamp_has_no_offset() {
        let v = chrono::NaiveDate::from_ymd_opt(2026, 11, 2)
            .unwrap()
            .and_hms_micro_opt(18, 52, 18, 120_000)
            .unwrap();
        assert_eq!(
            DbValue::naive_timestamp(v),
            DbValue::Timestamp("2026-11-02T18:52:18.120".into())
        );
    }

    #[test]
    fn detects_timestamp_offset() {
        assert!(timestamp_has_offset("2026-11-02T18:52:18+00:00"));
        assert!(timestamp_has_offset("2026-11-02 18:52:18-03"));
        assert!(timestamp_has_offset("2026-11-02T18:52:18Z"));
        assert!(!timestamp_has_offset("2026-11-02T18:52:18"));
        assert!(!timestamp_has_offset("2026-11-02 18:52:18.5"));
        assert!(!timestamp_has_offset("2026-11-02"));
    }
}
