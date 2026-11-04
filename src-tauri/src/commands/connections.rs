use crate::runtime as tauri;
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn list_saved_connections(
    state: State<'_, AppState>,
) -> CmdResult<Vec<app_store::SavedConnection>> {
    Ok(state.store.list_connections()?)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_connection(state: State<'_, AppState>, config: ConnectionConfig) -> CmdResult<()> {
    Ok(state.store.save_connection(config)?)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_connection(state: State<'_, AppState>, conn_id: String) -> CmdResult<()> {
    state.pools.disconnect(&conn_id).await?;
    Ok(state.store.delete_connection(&conn_id)?)
}

/// Prueba la conexión sin registrarla en el pool manager. Al editar una
/// conexión existente el formulario no recibe la password guardada: sin
/// password (`None`) se usa la del keyring, igual que hace `save_connection`;
/// vacía es "sin password".
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn test_connection(
    state: State<'_, AppState>,
    mut config: ConnectionConfig,
) -> CmdResult<()> {
    match config.password.as_deref() {
        None => config.password = state.store.saved_password(&config.id)?,
        Some("") => config.password = None,
        Some(_) => {}
    }
    let handle = EngineHandle::connect(&config, 1).await?;
    handle.ping().await?;
    handle.disconnect().await;
    Ok(())
}

/// `database` opcional: reconecta el pool a otra database de la misma
/// conexión (Postgres tiene pools por database).
#[cfg_attr(feature = "desktop", tauri::command)]
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn disconnect(state: State<'_, AppState>, conn_id: String) -> CmdResult<()> {
    state.pools.disconnect(&conn_id).await?;
    state
        .schemas
        .lock()
        .unwrap()
        .retain(|key, _| !key.starts_with(&format!("{conn_id}/")));
    Ok(())
}

/// Paquete cifrado (`ZNH1.…`) con las conexiones elegidas y sus passwords.
/// Argon2 tarda: corre fuera del hilo de la UI.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn export_connections(
    state: State<'_, AppState>,
    ids: Vec<String>,
    passphrase: String,
) -> CmdResult<String> {
    let configs = state.store.connections_with_passwords(&ids)?;
    tauri::async_runtime::spawn_blocking(move || app_store::transfer::seal(configs, &passphrase))
        .await
        .map_err(|e| e.to_string())?
        .map_err(Into::into)
}

/// Descifra un paquete exportado; el frontend muestra el resultado antes de
/// guardar nada.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn decrypt_connections(
    token: String,
    passphrase: String,
) -> CmdResult<Vec<ConnectionConfig>> {
    tauri::async_runtime::spawn_blocking(move || app_store::transfer::open(&token, &passphrase))
        .await
        .map_err(|e| e.to_string())?
        .map_err(Into::into)
}
