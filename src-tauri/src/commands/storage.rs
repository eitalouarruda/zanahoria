use crate::runtime as tauri;
use app_store::{FavoriteQuery, HistoryEntry};
use tauri::State;

use crate::commands::save_target::SaveTarget;
use crate::error::CmdResult;
use crate::state::AppState;

#[cfg_attr(feature = "desktop", tauri::command)]
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn clear_history(state: State<'_, AppState>, conn_id: Option<String>) -> CmdResult<()> {
    Ok(state.store.clear_history(conn_id.as_deref())?)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn list_favorites(state: State<'_, AppState>) -> CmdResult<Vec<FavoriteQuery>> {
    Ok(state.store.list_favorites()?)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_favorite(
    state: State<'_, AppState>,
    favorite: FavoriteQuery,
) -> CmdResult<FavoriteQuery> {
    Ok(state.store.save_favorite(favorite)?)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn delete_favorite(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.store.delete_favorite(&id)?)
}

/// Guarda contenido exportado (CSV/JSON/SQL) en la ruta elegida por el
/// usuario mediante el dialog de guardado.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_text_file(app: tauri::AppHandle, path: String, content: String) -> CmdResult<()> {
    let target = SaveTarget::new(&app, &path)?;
    std::fs::write(target.local(), content)
        .and_then(|()| target.commit(&app))
        .map_err(|e| crate::error::CmdError {
            message: format!("could not write {path}: {e}"),
        })
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn kv_get(
    state: State<'_, AppState>,
    table: String,
    key: String,
) -> CmdResult<Option<serde_json::Value>> {
    Ok(state.store.get_kv(&table, &key)?)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn kv_set(
    state: State<'_, AppState>,
    table: String,
    key: String,
    value: serde_json::Value,
) -> CmdResult<()> {
    Ok(state.store.set_kv(&table, &key, &value)?)
}

/// Lee un archivo de texto elegido en el diálogo de abrir (ruta o, en
/// Android, URI `content://`).
#[cfg_attr(feature = "desktop", tauri::command)]
#[cfg(feature = "desktop")]
pub fn read_text_file(app: tauri::AppHandle, path: String) -> CmdResult<String> {
    use std::str::FromStr;
    use tauri_plugin_fs::{FilePath, FsExt};
    let file = FilePath::from_str(&path).map_err(|e| crate::error::CmdError {
        message: format!("invalid path {path}: {e}"),
    })?;
    app.fs()
        .read_to_string(file)
        .map_err(|e| crate::error::CmdError {
            message: format!("could not read {path}: {e}"),
        })
}

#[cfg(not(feature = "desktop"))]
pub fn read_text_file(app: tauri::AppHandle, path: String) -> CmdResult<String> {
    let path = app.file_path(&path)?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Text file exceeds 16 MiB".to_string().into());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string().into())
}
