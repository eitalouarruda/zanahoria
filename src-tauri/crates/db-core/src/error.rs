use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("connection error: {0}")]
    Connection(String),
    #[error("query error: {0}")]
    Query(String),
    #[error("connection not found: {0}")]
    NotFound(String),
    #[error("unsupported operation for this engine: {0}")]
    Unsupported(String),
    #[error("{0}")]
    Other(String),
}

impl From<sqlx::Error> for DbError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::Database(db) => DbError::Query(db.to_string()),
            sqlx::Error::Io(_) | sqlx::Error::Tls(_) | sqlx::Error::PoolTimedOut => {
                DbError::Connection(e.to_string())
            }
            other => DbError::Query(other.to_string()),
        }
    }
}

pub type Result<T, E = DbError> = std::result::Result<T, E>;
