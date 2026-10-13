use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use db_core::{DbError, DbSchema, EngineHandle, PoolManager};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

pub struct RunningQuery {
    pub cancel: CancellationToken,
    pub resume: Arc<Notify>,
}

pub struct AppState {
    pub pools: PoolManager,
    pub store: app_store::AppStore,
    pub queries: Mutex<HashMap<String, RunningQuery>>,
    /// Cache de schema por "conn_id/database" para autocomplete y editabilidad.
    pub schemas: Mutex<HashMap<String, DbSchema>>,
    /// Jobs de backup/restore en curso (cancelación).
    pub jobs: Mutex<HashMap<String, CancellationToken>>,
}

impl AppState {
    pub fn new(store: app_store::AppStore) -> Self {
        let max_conns = if cfg!(target_os = "android") { 2 } else { 5 };
        Self {
            pools: PoolManager::new(max_conns),
            store,
            queries: Mutex::new(HashMap::new()),
            schemas: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
        }
    }

    /// Handle de la conexión apuntando a `database` (abre un pool para esa
    /// database la primera vez). Vacío = la database principal.
    pub async fn handle_for(
        &self,
        conn_id: &str,
        database: &str,
    ) -> Result<Arc<EngineHandle>, DbError> {
        self.pools
            .get_for_database(conn_id, database, || {
                self.store
                    .connection_for_connect(conn_id)
                    .map_err(|e| DbError::Other(e.to_string()))
            })
            .await
    }

    pub fn schema_key(conn_id: &str, database: &str) -> String {
        format!("{conn_id}/{database}")
    }
}
