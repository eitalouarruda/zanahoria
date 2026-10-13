//! app-store: storage local de la app (conexiones, history, favorites,
//! settings) sobre SQLite, con credenciales fuera del archivo principal
//! (OS keyring en desktop, archivo cifrado como fallback/Android).

mod secrets;
mod store;

pub use secrets::{FileCipherStore, SecretStore};
pub use store::{AppStore, FavoriteQuery, HistoryEntry, SavedConnection};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("storage error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("secret store error: {0}")]
    Secret(String),
    #[error("{0}")]
    Other(String),
}

pub type Result<T, E = StoreError> = std::result::Result<T, E>;
