use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::config::ConnectionConfig;
use crate::engines::EngineHandle;
use crate::error::{DbError, Result};

/// Handles abiertos de una conexión: el principal (la database con la que se
/// conectó) y uno extra por cada otra database usada desde algún tab.
/// Postgres no puede cambiar de database en una conexión abierta, así que
/// cada database necesita su propio pool.
struct ConnEntry {
    primary_db: String,
    handles: HashMap<String, Arc<EngineHandle>>,
}

/// Registro de conexiones abiertas, indexado por id de conexión.
#[derive(Default)]
pub struct PoolManager {
    conns: RwLock<HashMap<String, ConnEntry>>,
    max_conns: u32,
}

impl PoolManager {
    pub fn new(max_conns: u32) -> Self {
        Self {
            conns: RwLock::new(HashMap::new()),
            max_conns,
        }
    }

    /// Abre la conexión principal (reemplaza la entrada anterior, si había).
    pub async fn connect(&self, cfg: &ConnectionConfig) -> Result<Arc<EngineHandle>> {
        let handle = Arc::new(EngineHandle::connect(cfg, self.max_conns).await?);
        let entry = ConnEntry {
            primary_db: cfg.database.clone(),
            handles: HashMap::from([(cfg.database.clone(), handle.clone())]),
        };
        let old = self.conns.write().await.insert(cfg.id.clone(), entry);
        if let Some(old) = old {
            for h in old.handles.into_values() {
                h.disconnect().await;
            }
        }
        Ok(handle)
    }

    /// Handle principal de la conexión.
    pub async fn get(&self, conn_id: &str) -> Result<Arc<EngineHandle>> {
        let conns = self.conns.read().await;
        let entry = conns
            .get(conn_id)
            .ok_or_else(|| DbError::NotFound(conn_id.to_string()))?;
        entry
            .handles
            .get(&entry.primary_db)
            .cloned()
            .ok_or_else(|| DbError::NotFound(conn_id.to_string()))
    }

    /// Handle para una database concreta de una conexión abierta. Si aún no
    /// existe se abre con `cfg` (la config guardada de la conexión) apuntando
    /// a esa database. Engines sin múltiples databases usan el principal.
    pub async fn get_for_database(
        &self,
        conn_id: &str,
        database: &str,
        cfg: impl FnOnce() -> Result<ConnectionConfig>,
    ) -> Result<Arc<EngineHandle>> {
        let primary = {
            let conns = self.conns.read().await;
            let entry = conns
                .get(conn_id)
                .ok_or_else(|| DbError::NotFound(conn_id.to_string()))?;
            if database.is_empty() {
                None
            } else if let Some(h) = entry.handles.get(database) {
                return Ok(h.clone());
            } else {
                entry.handles.get(&entry.primary_db).cloned()
            }
        };
        let primary = match primary {
            Some(p) => p,
            None => return self.get(conn_id).await,
        };
        if !primary.capabilities().multiple_databases {
            return Ok(primary);
        }

        let mut cfg = cfg()?;
        cfg.database = database.to_string();
        let handle = Arc::new(EngineHandle::connect(&cfg, self.max_conns).await?);
        let mut conns = self.conns.write().await;
        let Some(entry) = conns.get_mut(conn_id) else {
            // Se desconectó mientras abríamos: no dejar el pool huérfano.
            handle.disconnect().await;
            return Err(DbError::NotFound(conn_id.to_string()));
        };
        // Otra tarea pudo abrirla en paralelo: quedarse con la existente.
        if let Some(existing) = entry.handles.get(database) {
            let existing = existing.clone();
            drop(conns);
            handle.disconnect().await;
            return Ok(existing);
        }
        entry.handles.insert(database.to_string(), handle.clone());
        Ok(handle)
    }

    /// Cierra todos los handles (principal y por database) de la conexión.
    pub async fn disconnect(&self, conn_id: &str) -> Result<()> {
        let entry = self.conns.write().await.remove(conn_id);
        if let Some(entry) = entry {
            for h in entry.handles.into_values() {
                h.disconnect().await;
            }
        }
        Ok(())
    }

    pub async fn is_connected(&self, conn_id: &str) -> bool {
        self.conns.read().await.contains_key(conn_id)
    }
}
