use db_core::DbSchema;
use tauri::State;

use crate::error::CmdResult;
use crate::state::AppState;

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>, conn_id: String) -> CmdResult<Vec<String>> {
    let handle = state.pools.get(&conn_id).await?;
    Ok(handle.list_databases().await?)
}

#[tauri::command]
pub async fn get_schema(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> CmdResult<DbSchema> {
    let key = AppState::schema_key(&conn_id, &database);
    if let Some(schema) = state.schemas.lock().unwrap().get(&key) {
        return Ok(schema.clone());
    }
    refresh_schema(state, conn_id, database).await
}

#[tauri::command]
pub async fn refresh_schema(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> CmdResult<DbSchema> {
    let handle = state.handle_for(&conn_id, &database).await?;
    let schema = handle.introspect(&database).await?;
    let key = AppState::schema_key(&conn_id, &database);
    state.schemas.lock().unwrap().insert(key, schema.clone());
    Ok(schema)
}
