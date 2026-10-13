use db_core::{build_mutations, Editability, MutationResult, MutationStatement, PendingChange};
use serde::Serialize;
use tauri::State;

use crate::error::CmdResult;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationPreview {
    pub statements: Vec<MutationStatement>,
    pub safe_mode: bool,
}

/// Genera el SQL del Code Preview a partir de los cambios pendientes del grid.
#[tauri::command]
pub fn preview_mutations(
    state: State<'_, AppState>,
    conn_id: String,
    editability: Editability,
    changes: Vec<PendingChange>,
) -> CmdResult<MutationPreview> {
    let config = state.store.connection_for_connect(&conn_id)?;
    let statements = build_mutations(config.engine, &editability, &changes, config.safe_mode)?;
    Ok(MutationPreview {
        statements,
        safe_mode: config.safe_mode,
    })
}

/// Aplica los cambios (siempre en transacción). El frontend manda los mismos
/// pending changes que mostró en el preview.
#[tauri::command]
pub async fn apply_mutations(
    state: State<'_, AppState>,
    conn_id: String,
    // Database del tab: los cambios se aplican en su pool.
    database: Option<String>,
    editability: Editability,
    changes: Vec<PendingChange>,
) -> CmdResult<MutationResult> {
    let config = state.store.connection_for_connect(&conn_id)?;
    let statements = build_mutations(config.engine, &editability, &changes, config.safe_mode)?;
    let handle = state
        .handle_for(&conn_id, database.as_deref().unwrap_or(""))
        .await?;
    Ok(handle.apply_mutations(statements, true).await?)
}
