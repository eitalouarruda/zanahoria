use db_core::{Capabilities, ConnectionConfig, EngineHandle};
use serde::Serialize;
use tauri::State;

use crate::error::CmdResult;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    pub conn_id: String,
    pub capabilities: Capabilities,
    pub databases: Vec<String>,
}

#[tauri::command]
pub fn list_saved_connections(
    state: State<'_, AppState>,
) -> CmdResult<Vec<app_store::SavedConnection>> {
    Ok(state.store.list_connections()?)
}

#[tauri::command]
pub fn save_connection(state: State<'_, AppState>, config: ConnectionConfig) -> CmdResult<()> {
    Ok(state.store.save_connection(config)?)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, conn_id: String) -> CmdResult<()> {
    state.pools.disconnect(&conn_id).await?;
    Ok(state.store.delete_connection(&conn_id)?)
}

/// Prueba la conexión sin registrarla en el pool manager. Al editar una
/// conexión existente el formulario no recibe la password guardada; si llega
/// vacía se usa la del keyring, igual que hace `save_connection`.
#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    mut config: ConnectionConfig,
) -> CmdResult<()> {
    if config.password.as_deref().unwrap_or("").is_empty() {
        if let Some(saved) = state.store.saved_password(&config.id)? {
            config.password = Some(saved);
        }
    }
    let handle = EngineHandle::connect(&config, 1).await?;
    handle.ping().await?;
    handle.disconnect().await;
    Ok(())
}

/// `database` opcional: reconecta el pool a otra database de la misma
/// conexión (Postgres tiene pools por database).
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
) -> CmdResult<ConnInfo> {
    let mut config = state.store.connection_for_connect(&conn_id)?;
    if let Some(db) = database {
        config.database = db;
    }
    state.pools.disconnect(&conn_id).await?;
    let handle = state.pools.connect(&config).await?;
    let databases = handle.list_databases().await.unwrap_or_default();
    Ok(ConnInfo {
        conn_id,
        capabilities: handle.capabilities(),
        databases,
    })
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, conn_id: String) -> CmdResult<()> {
    state.pools.disconnect(&conn_id).await?;
    state
        .schemas
        .lock()
        .unwrap()
        .retain(|key, _| !key.starts_with(&format!("{conn_id}/")));
    Ok(())
}
