use serde::Serialize;

/// Error serializable hacia el frontend.
#[derive(Debug, Serialize)]
pub struct CmdError {
    pub message: String,
}

impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<db_core::DbError> for CmdError {
    fn from(e: db_core::DbError) -> Self {
        CmdError {
            message: e.to_string(),
        }
    }
}

impl From<app_store::StoreError> for CmdError {
    fn from(e: app_store::StoreError) -> Self {
        CmdError {
            message: e.to_string(),
        }
    }
}

impl From<String> for CmdError {
    fn from(message: String) -> Self {
        CmdError { message }
    }
}

pub type CmdResult<T> = Result<T, CmdError>;
