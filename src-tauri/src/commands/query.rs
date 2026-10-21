use std::sync::Arc;
use std::time::Instant;

use db_core::{
    analyze_query, dangerous_statements, is_read_only, Editability, ErrorPosition, ExecEvent,
    ExecOpts,
};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::error::CmdResult;
use crate::state::{AppState, RunningQuery};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunQueryResponse {
    /// false si Safe Mode exige confirmación (ver `warnings`).
    pub started: bool,
    pub editability: Option<Editability>,
    pub warnings: Vec<String>,
    /// Se puede re-ejecutar sin efectos (p.ej. para exportar todas las filas).
    pub read_only: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QueryEventPayload {
    query_id: String,
    #[serde(flatten)]
    event: QueryEventBody,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum QueryEventBody {
    Exec {
        event: ExecEvent,
    },
    Error {
        message: String,
        /// Posición del error dentro del SQL enviado, si el motor la reporta.
        position: Option<ErrorPosition>,
    },
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_query(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    // Lo genera el frontend para poder registrar el listener antes de que
    // lleguen los primeros events (evita perder chunks por la carrera).
    query_id: String,
    conn_id: String,
    database: String,
    sql: String,
    opts: Option<ExecOpts>,
    confirm_dangerous: Option<bool>,
) -> CmdResult<RunQueryResponse> {
    let handle = state.handle_for(&conn_id, &database).await?;
    let caps = handle.capabilities();

    let config = state.store.connection_for_connect(&conn_id)?;

    // Safe Mode: statements peligrosos escritos a mano piden confirmación.
    if caps.sql && config.safe_mode && !confirm_dangerous.unwrap_or(false) {
        let warnings = dangerous_statements(config.engine, &sql);
        if !warnings.is_empty() {
            return Ok(RunQueryResponse {
                started: false,
                editability: None,
                warnings,
                read_only: false,
            });
        }
    }

    let editability = if caps.sql {
        let key = AppState::schema_key(&conn_id, &database);
        let schemas = state.schemas.lock().unwrap();
        Some(match schemas.get(&key) {
            Some(schema) => analyze_query(config.engine, &sql, schema),
            None => Editability {
                editable: false,
                reason: Some("schema not loaded yet".into()),
                ..Default::default()
            },
        })
    } else {
        None
    };

    let read_only = caps.sql && is_read_only(config.engine, &sql);
    let stream = handle.execute(sql.clone(), opts.unwrap_or_default());
    state.queries.lock().unwrap().insert(
        query_id.clone(),
        RunningQuery {
            cancel: stream.cancel.clone(),
            resume: Arc::clone(&stream.resume),
        },
    );

    spawn_forwarder(app, query_id, conn_id, database, sql, stream);

    Ok(RunQueryResponse {
        started: true,
        editability,
        warnings: Vec::new(),
        read_only,
    })
}

/// Reenvía los eventos del stream hacia la webview y registra el history al
/// terminar. Se limpia solo del registro de queries activas.
fn spawn_forwarder(
    app: tauri::AppHandle,
    query_id: String,
    conn_id: String,
    database: String,
    sql: String,
    mut stream: db_core::QueryStream,
) {
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut status = "ok";
        while let Some(item) = stream.events.recv().await {
            let (body, finished) = match item {
                Ok(event) => {
                    let finished =
                        matches!(&event, ExecEvent::Done { summary } if !summary.truncated);
                    (QueryEventBody::Exec { event }, finished)
                }
                Err(e) => {
                    status = "error";
                    (
                        QueryEventBody::Error {
                            message: e.to_string(),
                            position: e.position().cloned(),
                        },
                        true,
                    )
                }
            };
            let _ = app.emit(
                "query:event",
                QueryEventPayload {
                    query_id: query_id.clone(),
                    event: body,
                },
            );
            if finished {
                break;
            }
        }
        if let Some(state) = app.try_state::<AppState>() {
            state.queries.lock().unwrap().remove(&query_id);
            let _ = state.store.add_history(
                &conn_id,
                &database,
                &sql,
                status,
                started.elapsed().as_millis() as i64,
            );
        }
    });
}

#[tauri::command]
pub fn fetch_more(state: State<'_, AppState>, query_id: String) -> CmdResult<()> {
    if let Some(q) = state.queries.lock().unwrap().get(&query_id) {
        q.resume.notify_one();
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_query(state: State<'_, AppState>, query_id: String) -> CmdResult<()> {
    if let Some(q) = state.queries.lock().unwrap().remove(&query_id) {
        q.cancel.cancel();
    }
    Ok(())
}
