use serde::Serialize;
use thiserror::Error;

/// Dónde ocurrió un error dentro del SQL enviado (relativo a ese texto).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ErrorPosition {
    /// Offset en caracteres (code points), 0-based (Postgres).
    Offset { offset: usize },
    /// Línea 1-based (MySQL/MariaDB: "... at line N"), relativa al inicio
    /// (sin espacios iniciales) del statement `statement` (0-based) del script.
    Line { line: usize, statement: usize },
}

#[derive(Debug, Error)]
pub enum DbError {
    #[error("connection error: {0}")]
    Connection(String),
    #[error("query error: {0}")]
    Query(String),
    #[error("query error: {message}")]
    QueryAt {
        message: String,
        position: ErrorPosition,
    },
    #[error("connection not found: {0}")]
    NotFound(String),
    #[error("unsupported operation for this engine: {0}")]
    Unsupported(String),
    #[error("{0}")]
    Other(String),
}

impl DbError {
    pub fn position(&self) -> Option<&ErrorPosition> {
        match self {
            DbError::QueryAt { position, .. } => Some(position),
            _ => None,
        }
    }

    /// Fija qué statement del script falló (los que ya completaron antes).
    pub fn in_statement(mut self, index: usize) -> Self {
        if let DbError::QueryAt {
            position: ErrorPosition::Line { statement, .. },
            ..
        } = &mut self
        {
            *statement = index;
        }
        self
    }
}

impl From<sqlx::Error> for DbError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::Database(db) => {
                let message = db.to_string();
                match db_error_position(db.as_ref(), &message) {
                    Some(position) => DbError::QueryAt { message, position },
                    None => DbError::Query(message),
                }
            }
            sqlx::Error::Io(_) | sqlx::Error::Tls(_) | sqlx::Error::PoolTimedOut => {
                DbError::Connection(e.to_string())
            }
            other => DbError::Query(other.to_string()),
        }
    }
}

fn db_error_position(db: &dyn sqlx::error::DatabaseError, message: &str) -> Option<ErrorPosition> {
    use sqlx::mysql::MySqlDatabaseError;
    use sqlx::postgres::{PgDatabaseError, PgErrorPosition};

    if let Some(pg) = db.try_downcast_ref::<PgDatabaseError>() {
        // Solo la posición en el SQL original; `Internal` apunta a SQL generado
        // (p.ej. dentro de una función PL/pgSQL) que el usuario no ve.
        return match pg.position()? {
            PgErrorPosition::Original(p) => Some(ErrorPosition::Offset {
                offset: p.saturating_sub(1),
            }),
            PgErrorPosition::Internal { .. } => None,
        };
    }
    if db.try_downcast_ref::<MySqlDatabaseError>().is_some() {
        return mysql_error_line(message).map(|line| ErrorPosition::Line { line, statement: 0 });
    }
    None
}

/// MySQL/MariaDB terminan los errores de sintaxis con "at line N".
fn mysql_error_line(message: &str) -> Option<usize> {
    let idx = message.rfind(" at line ")?;
    let digits: String = message[idx + " at line ".len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok().filter(|&n| n > 0)
}

pub type Result<T, E = DbError> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mysql_line() {
        let msg = "1064 (42000): You have an error in your SQL syntax; check the manual \
                   that corresponds to your MySQL server version for the right syntax \
                   to use near ')' at line 3";
        assert_eq!(mysql_error_line(msg), Some(3));
        assert_eq!(mysql_error_line("Unknown column 'x' in 'field list'"), None);
    }
}
