use app_store::{FavoriteQuery, HistoryEntry};
use tauri::State;

use crate::error::CmdResult;
use crate::state::AppState;

#[tauri::command]
pub fn get_history(
    state: State<'_, AppState>,
    conn_id: Option<String>,
    search: Option<String>,
    limit: Option<usize>,
) -> CmdResult<Vec<HistoryEntry>> {
    Ok(state
        .store
        .get_history(conn_id.as_deref(), search.as_deref(), limit.unwrap_or(200))?)
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>, conn_id: Option<String>) -> CmdResult<()> {
    Ok(state.store.clear_history(conn_id.as_deref())?)
}

#[tauri::command]
pub fn list_favorites(state: State<'_, AppState>) -> CmdResult<Vec<FavoriteQuery>> {
    Ok(state.store.list_favorites()?)
}

#[tauri::command]
pub fn save_favorite(
    state: State<'_, AppState>,
    favorite: FavoriteQuery,
) -> CmdResult<FavoriteQuery> {
    Ok(state.store.save_favorite(favorite)?)
}

#[tauri::command]
pub fn delete_favorite(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.store.delete_favorite(&id)?)
}

/// Guarda contenido exportado (CSV/JSON/SQL) en la ruta elegida por el
/// usuario mediante el dialog de guardado.
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> CmdResult<()> {
    std::fs::write(&path, content).map_err(|e| crate::error::CmdError {
        message: format!("could not write {path}: {e}"),
    })
}

#[tauri::command]
pub fn kv_get(
    state: State<'_, AppState>,
    table: String,
    key: String,
) -> CmdResult<Option<serde_json::Value>> {
    Ok(state.store.get_kv(&table, &key)?)
}

#[tauri::command]
pub fn kv_set(
    state: State<'_, AppState>,
    table: String,
    key: String,
    value: serde_json::Value,
) -> CmdResult<()> {
    Ok(state.store.set_kv(&table, &key, &value)?)
}
