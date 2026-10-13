use tauri::State;

#[cfg(target_os = "android")]
use crate::error::CmdError;
use crate::error::CmdResult;
use crate::state::AppState;

/// Respaldo de SQLite (VACUUM INTO): funciona en todas las plataformas.
#[tauri::command]
pub async fn sqlite_backup(
    state: State<'_, AppState>,
    conn_id: String,
    dest: String,
) -> CmdResult<()> {
    let handle = state.pools.get(&conn_id).await?;
    Ok(handle.sqlite_vacuum_into(&dest).await?)
}

#[cfg(not(target_os = "android"))]
mod desktop {
    use std::collections::HashMap;

    use serde::Serialize;
    use tauri::{Emitter, Manager, State};

    use crate::error::{CmdError, CmdResult};
    use crate::state::AppState;

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct JobEvent {
        job_id: String,
        #[serde(flatten)]
        line: backup::JobLine,
    }

    fn overrides(state: &AppState) -> HashMap<String, String> {
        state
            .store
            .get_kv("settings", "backup_tool_paths")
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    #[tauri::command]
    pub async fn detect_backup_tools(
        state: State<'_, AppState>,
    ) -> CmdResult<Vec<backup::ToolStatus>> {
        let ov = overrides(&state);
        Ok(backup::detect_tools(&ov).await)
    }

    #[tauri::command]
    pub fn set_backup_tool_path(
        state: State<'_, AppState>,
        name: String,
        path: String,
    ) -> CmdResult<()> {
        let mut ov = overrides(&state);
        if path.is_empty() {
            ov.remove(&name);
        } else {
            ov.insert(name, path);
        }
        Ok(state
            .store
            .set_kv("settings", "backup_tool_paths", &serde_json::json!(ov))?)
    }

    #[tauri::command]
    pub fn sniff_dump_file(path: String) -> CmdResult<backup::SniffResult> {
        backup::sniff_dump(&path).map_err(|e| CmdError {
            message: e.to_string(),
        })
    }

    async fn launch(app: tauri::AppHandle, spec: backup::JobSpec) -> CmdResult<String> {
        let job_id = uuid::Uuid::new_v4().to_string();
        let mut handle = backup::run_job(spec).await.map_err(|e| CmdError {
            message: e.to_string(),
        })?;
        {
            let state = app.state::<AppState>();
            state
                .jobs
                .lock()
                .unwrap()
                .insert(job_id.clone(), handle.cancel.clone());
        }
        let id = job_id.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(line) = handle.lines.recv().await {
                let done = matches!(line, backup::JobLine::Done { .. });
                let _ = app.emit(
                    "backup:event",
                    JobEvent {
                        job_id: id.clone(),
                        line,
                    },
                );
                if done {
                    break;
                }
            }
            if let Some(state) = app.try_state::<AppState>() {
                state.jobs.lock().unwrap().remove(&id);
            }
        });
        Ok(job_id)
    }

    /// Devuelve (job_id, comando mostrable). El progreso llega por
    /// events `backup:event`.
    #[tauri::command]
    pub async fn start_backup(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        conn_id: String,
        options: backup::BackupOptions,
    ) -> CmdResult<(String, String)> {
        let cfg = state.store.connection_for_connect(&conn_id)?;
        let tools = tool_paths(&state).await;
        let spec = backup::build_backup_command(&cfg, &options, &tools).map_err(|e| CmdError {
            message: e.to_string(),
        })?;
        let display = spec.display.clone();
        Ok((launch(app, spec).await?, display))
    }

    #[tauri::command]
    pub async fn start_restore(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        conn_id: String,
        options: backup::RestoreOptions,
    ) -> CmdResult<(String, String)> {
        let cfg = state.store.connection_for_connect(&conn_id)?;
        let sniff = backup::sniff_dump(&options.input).map_err(|e| CmdError {
            message: e.to_string(),
        })?;
        let tools = tool_paths(&state).await;
        let spec = backup::build_restore_command(&cfg, &sniff, &options, &tools).map_err(|e| {
            CmdError {
                message: e.to_string(),
            }
        })?;
        let display = spec.display.clone();
        Ok((launch(app, spec).await?, display))
    }

    #[tauri::command]
    pub fn cancel_job(state: State<'_, AppState>, job_id: String) -> CmdResult<()> {
        if let Some(cancel) = state.jobs.lock().unwrap().remove(&job_id) {
            cancel.cancel();
        }
        Ok(())
    }

    async fn tool_paths(state: &AppState) -> HashMap<String, String> {
        let ov = overrides(state);
        backup::detect_tools(&ov)
            .await
            .into_iter()
            .filter_map(|t| t.path.map(|p| (t.name, p)))
            .collect()
    }
}

#[cfg(not(target_os = "android"))]
pub use desktop::*;

#[cfg(target_os = "android")]
mod mobile {
    use super::*;

    #[tauri::command]
    pub fn detect_backup_tools() -> CmdResult<Vec<serde_json::Value>> {
        Ok(Vec::new())
    }

    #[tauri::command]
    pub fn set_backup_tool_path(_name: String, _path: String) -> CmdResult<()> {
        unsupported()
    }

    #[tauri::command]
    pub fn sniff_dump_file(_path: String) -> CmdResult<serde_json::Value> {
        unsupported()
    }

    #[tauri::command]
    pub fn start_backup(_conn_id: String) -> CmdResult<(String, String)> {
        unsupported()
    }

    #[tauri::command]
    pub fn start_restore(_conn_id: String) -> CmdResult<(String, String)> {
        unsupported()
    }

    #[tauri::command]
    pub fn cancel_job(_job_id: String) -> CmdResult<()> {
        unsupported()
    }

    fn unsupported<T>() -> CmdResult<T> {
        Err(CmdError {
            message: "backup/restore is not available on mobile".into(),
        })
    }
}

#[cfg(target_os = "android")]
pub use mobile::*;
