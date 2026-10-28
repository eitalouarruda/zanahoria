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

    use std::sync::atomic::Ordering;

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

    fn backup_err(e: backup::BackupError) -> CmdError {
        CmdError {
            message: e.to_string(),
        }
    }

    /// Verificación al terminar con éxito: terminar sin error no alcanza.
    enum Verify {
        /// Las tablas esperadas tienen que existir en el destino.
        Restore {
            conn_id: String,
            target_db: String,
            /// Tablas según el TOC del archive (restore directo); si es None
            /// se usan las que contó el filtro.
            expected: Option<usize>,
        },
        /// El archivo generado tiene que poder leerse de vuelta.
        Backup {
            path: String,
            pg_restore: Option<String>,
        },
    }

    async fn verify_restore(
        app: &tauri::AppHandle,
        conn_id: &str,
        target_db: &str,
        expected: Option<usize>,
        stats: &backup::JobStats,
    ) -> Result<String, String> {
        let expected = expected.unwrap_or_else(|| stats.tables_seen.load(Ordering::Relaxed));
        let state = app.state::<AppState>();
        let handle = state
            .handle_for(conn_id, target_db)
            .await
            .map_err(|e| format!("verification failed: {e}"))?;
        let found = handle
            .user_table_count()
            .await
            .map_err(|e| format!("verification failed: {e}"))?;
        // Invalida el schema cacheado: la database cambió.
        state
            .schemas
            .lock()
            .unwrap()
            .remove(&AppState::schema_key(conn_id, target_db));
        let summary = format!("verify: {expected} tables expected, {found} found");
        if (found as usize) < expected {
            Err(summary)
        } else {
            Ok(summary)
        }
    }

    async fn run_verify(
        app: &tauri::AppHandle,
        verify: &Verify,
        stats: &backup::JobStats,
    ) -> Result<String, String> {
        match verify {
            Verify::Restore {
                conn_id,
                target_db,
                expected,
            } => verify_restore(app, conn_id, target_db, *expected, stats).await,
            Verify::Backup { path, pg_restore } => {
                backup::verify_backup(path, pg_restore.as_deref()).await
            }
        }
    }

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct ProgressEvent {
        job_id: String,
        done: u64,
        /// 0 = total desconocido.
        total: u64,
    }

    async fn launch_with(
        app: tauri::AppHandle,
        spec: backup::JobSpec,
        verify: Option<Verify>,
        progress_total: u64,
    ) -> CmdResult<String> {
        let job_id = uuid::Uuid::new_v4().to_string();
        let mut handle = backup::run_job(spec).await.map_err(backup_err)?;
        if progress_total > 0 {
            handle
                .stats
                .progress_total
                .store(progress_total, Ordering::Relaxed);
        }
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
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(400));
            let mut last = (u64::MAX, u64::MAX);
            loop {
                let mut line = tokio::select! {
                    line = handle.lines.recv() => match line {
                        Some(line) => line,
                        None => break,
                    },
                    _ = tick.tick() => {
                        let now = (
                            handle.stats.progress_done.load(Ordering::Relaxed),
                            handle.stats.progress_total.load(Ordering::Relaxed),
                        );
                        if now != last {
                            last = now;
                            let _ = app.emit(
                                "backup:progress",
                                ProgressEvent { job_id: id.clone(), done: now.0, total: now.1 },
                            );
                        }
                        continue;
                    }
                };
                let done = matches!(line, backup::JobLine::Done { .. });
                if let (backup::JobLine::Done { success: true, .. }, Some(v)) = (&line, &verify) {
                    let (success, message) = match run_verify(&app, v, &handle.stats).await {
                        Ok(summary) => (true, format!("completed — {summary}")),
                        Err(summary) => (false, summary),
                    };
                    line = backup::JobLine::Done { success, message };
                }
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
        let statuses = detect(&state).await;
        let database = options
            .database
            .clone()
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| cfg.database.clone());
        // Total para el progreso: una unidad por tabla.
        let total = match state.handle_for(&conn_id, &database).await {
            Ok(h) => h.user_table_count().await.unwrap_or(0).max(0) as u64,
            Err(_) => 0,
        };
        // pg_dump se niega a respaldar un servidor de major más nuevo que él:
        // avisar antes con un mensaje claro.
        if matches!(cfg.engine, db_core::Engine::Postgres) {
            let server = match state.pools.get(&conn_id).await {
                Ok(h) => h.server_version().await.ok(),
                Err(_) => None,
            };
            let dump = statuses
                .iter()
                .find(|t| t.name == "pg_dump")
                .and_then(|t| t.version_num());
            if let (Some(server), Some(dump)) = (
                server.as_deref().and_then(backup::version::version_num),
                dump,
            ) {
                use backup::version::{pg_major, pg_major_label};
                if pg_major(dump) < pg_major(server) {
                    return Err(CmdError {
                        message: format!(
                            "pg_dump {} is older than the server ({}); choose pg_dump {} or newer in Tools",
                            pg_major_label(dump),
                            pg_major_label(server),
                            pg_major_label(server)
                        ),
                    });
                }
            }
        }
        let tools = paths(&statuses);
        let spec = backup::build_backup_command(&cfg, &options, &tools).map_err(backup_err)?;
        let display = spec.display.clone();
        let verify = Verify::Backup {
            path: options.output.clone(),
            pg_restore: tools.get("pg_restore").cloned(),
        };
        Ok((launch_with(app, spec, Some(verify), total).await?, display))
    }

    /// Versión del servidor, existencia de la database destino y cuántas
    /// tablas tiene ya.
    async fn target_info(state: &AppState, conn_id: &str, target_db: &str) -> backup::TargetInfo {
        let Ok(primary) = state.pools.get(conn_id).await else {
            // Sin conexión abierta no se puede inspeccionar: asumir que existe.
            return backup::TargetInfo {
                exists: true,
                ..Default::default()
            };
        };
        let version = primary.server_version().await.ok();
        let exists = match primary.list_databases().await {
            Ok(dbs) => dbs.iter().any(|d| d == target_db),
            Err(_) => true,
        };
        let tables = if exists {
            match state.handle_for(conn_id, target_db).await {
                Ok(h) => h.user_table_count().await.ok(),
                Err(_) => None,
            }
        } else {
            None
        };
        backup::TargetInfo {
            version,
            exists,
            tables,
        }
    }

    async fn make_plan(
        state: &AppState,
        conn_id: &str,
        options: &backup::RestoreOptions,
        statuses: &[backup::ToolStatus],
    ) -> CmdResult<backup::RestorePlan> {
        let cfg = state.store.connection_for_connect(conn_id)?;
        let sniff = backup::sniff_dump(&options.input).map_err(backup_err)?;
        let target = target_info(state, conn_id, &options.target_db).await;
        Ok(backup::plan_restore(
            cfg.engine,
            &sniff,
            statuses,
            &target,
            options.create_db,
            &options.target_db,
        ))
    }

    /// Analiza el dump y el destino sin ejecutar nada: versiones de origen y
    /// destino, estrategia, correcciones de compatibilidad, avisos y bloqueos.
    #[tauri::command]
    pub async fn plan_restore(
        state: State<'_, AppState>,
        conn_id: String,
        options: backup::RestoreOptions,
    ) -> CmdResult<backup::RestorePlan> {
        let statuses = detect(&state).await;
        make_plan(&state, &conn_id, &options, &statuses).await
    }

    #[tauri::command]
    pub async fn start_restore(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        conn_id: String,
        options: backup::RestoreOptions,
    ) -> CmdResult<(String, String)> {
        let cfg = state.store.connection_for_connect(&conn_id)?;
        // Safe mode protege la conexión de cambios: un restore los hace todos,
        // así que exige la confirmación explícita del usuario.
        if cfg.safe_mode && !options.confirm_safe_mode {
            return Err(CmdError {
                message: "this connection is in safe mode: confirm the restore explicitly".into(),
            });
        }
        let statuses = detect(&state).await;
        let plan = make_plan(&state, &conn_id, &options, &statuses).await?;
        let tools = paths(&statuses);
        let spec =
            backup::build_restore_command(&cfg, &plan, &options, &tools).map_err(backup_err)?;
        if !plan.target_exists && options.create_db {
            state
                .pools
                .get(&conn_id)
                .await?
                .create_database(&options.target_db)
                .await?;
        }
        let toc = match (plan.strategy, tools.get("pg_restore")) {
            (backup::Strategy::Direct | backup::Strategy::Compat, Some(pg_restore)) => {
                backup::archive_toc(pg_restore, &options.input).await
            }
            _ => None,
        };
        let verify = Verify::Restore {
            conn_id,
            target_db: options.target_db.clone(),
            // En compat el filtro cuenta los CREATE TABLE.
            expected: toc
                .filter(|_| plan.strategy == backup::Strategy::Direct)
                .map(|t| t.tables),
        };
        let total = toc.map(|t| t.data as u64).unwrap_or(0);
        let display = spec.display.clone();
        Ok((launch_with(app, spec, Some(verify), total).await?, display))
    }

    #[tauri::command]
    pub fn cancel_job(state: State<'_, AppState>, job_id: String) -> CmdResult<()> {
        if let Some(cancel) = state.jobs.lock().unwrap().remove(&job_id) {
            cancel.cancel();
        }
        Ok(())
    }

    async fn detect(state: &AppState) -> Vec<backup::ToolStatus> {
        backup::detect_tools(&overrides(state)).await
    }

    fn paths(statuses: &[backup::ToolStatus]) -> HashMap<String, String> {
        statuses
            .iter()
            .filter_map(|t| t.path.clone().map(|p| (t.name.clone(), p)))
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
    pub fn plan_restore(_conn_id: String) -> CmdResult<serde_json::Value> {
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
