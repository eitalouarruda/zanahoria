//! Web transport dispatches the same command functions as desktop.
use crate::{
    commands::*,
    error::CmdResult,
    runtime::{AppHandle, Manager},
    state::AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
fn encode<T: serde::Serialize>(value: T) -> CmdResult<Value> {
    serde_json::to_value(value).map_err(|e| e.to_string().into())
}
pub async fn dispatch(app: &AppHandle, name: &str, mut args: Value) -> CmdResult<Value> {
    validate(app, name, &mut args)?;
    match name {
        "list_saved_connections" => encode(connections::list_saved_connections(app.state())?),
        "save_connection" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                config: db_core::ConnectionConfig,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(connections::save_connection(app.state(), a.config)?)
        }
        "delete_connection" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(connections::delete_connection(app.state(), a.conn_id).await?)
        }
        "test_connection" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                config: db_core::ConnectionConfig,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(connections::test_connection(app.state(), a.config).await?)
        }
        "connect" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
                database: Option<String>,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(connections::connect(app.state(), a.conn_id, a.database).await?)
        }
        "disconnect" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(connections::disconnect(app.state(), a.conn_id).await?)
        }
        "export_connections" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                ids: Vec<String>,
                passphrase: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(connections::export_connections(app.state(), a.ids, a.passphrase).await?)
        }
        "decrypt_connections" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                token: String,
                passphrase: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(connections::decrypt_connections(a.token, a.passphrase).await?)
        }
        "run_query" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                query_id: String,
                conn_id: String,
                database: String,
                sql: String,
                opts: Option<db_core::ExecOpts>,
                confirm_dangerous: Option<bool>,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(
                query::run_query(
                    app.clone(),
                    app.state(),
                    a.query_id,
                    a.conn_id,
                    a.database,
                    a.sql,
                    a.opts,
                    a.confirm_dangerous,
                )
                .await?,
            )
        }
        "fetch_more" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                query_id: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(query::fetch_more(app.state(), a.query_id)?)
        }
        "cancel_query" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                query_id: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(query::cancel_query(app.state(), a.query_id)?)
        }
        "list_databases" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(schema::list_databases(app.state(), a.conn_id).await?)
        }
        "create_database" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
                name: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(schema::create_database(app.state(), a.conn_id, a.name).await?)
        }
        "get_schema" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
                database: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(schema::get_schema(app.state(), a.conn_id, a.database).await?)
        }
        "refresh_schema" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
                database: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(schema::refresh_schema(app.state(), a.conn_id, a.database).await?)
        }
        "preview_mutations" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
                editability: db_core::Editability,
                changes: Vec<db_core::PendingChange>,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(mutations::preview_mutations(
                app.state(),
                a.conn_id,
                a.editability,
                a.changes,
            )?)
        }
        "apply_mutations" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
                database: Option<String>,
                editability: db_core::Editability,
                changes: Vec<db_core::PendingChange>,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(
                mutations::apply_mutations(
                    app.state(),
                    a.conn_id,
                    a.database,
                    a.editability,
                    a.changes,
                )
                .await?,
            )
        }
        "get_history" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: Option<String>,
                search: Option<String>,
                limit: Option<usize>,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(storage::get_history(
                app.state(),
                a.conn_id,
                a.search,
                a.limit,
            )?)
        }
        "clear_history" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: Option<String>,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(storage::clear_history(app.state(), a.conn_id)?)
        }
        "list_favorites" => encode(storage::list_favorites(app.state())?),
        "save_favorite" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                favorite: app_store::FavoriteQuery,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(storage::save_favorite(app.state(), a.favorite)?)
        }
        "delete_favorite" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                id: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(storage::delete_favorite(app.state(), a.id)?)
        }
        "sqlite_backup" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
                dest: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(backup_cmd::sqlite_backup(app.state(), a.conn_id, a.dest).await?)
        }
        "detect_backup_tools" => encode(backup_cmd::detect_backup_tools(app.state()).await?),
        "set_backup_tool_path" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                name: String,
                path: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(backup_cmd::set_backup_tool_path(
                app.state(),
                a.name,
                a.path,
            )?)
        }
        "sniff_dump_file" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                path: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(backup_cmd::sniff_dump_file(a.path)?)
        }
        "start_backup" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
                options: backup::BackupOptions,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(backup_cmd::start_backup(app.clone(), app.state(), a.conn_id, a.options).await?)
        }
        "plan_restore" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
                options: backup::RestoreOptions,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(backup_cmd::plan_restore(app.state(), a.conn_id, a.options).await?)
        }
        "start_restore" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                conn_id: String,
                options: backup::RestoreOptions,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(backup_cmd::start_restore(app.clone(), app.state(), a.conn_id, a.options).await?)
        }
        "cancel_job" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                job_id: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(backup_cmd::cancel_job(app.state(), a.job_id)?)
        }
        "save_text_file" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                path: String,
                content: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(storage::save_text_file(app.clone(), a.path, a.content)?)
        }
        "read_text_file" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                path: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(storage::read_text_file(app.clone(), a.path)?)
        }
        "export_query" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                export_id: String,
                conn_id: String,
                database: String,
                sql: String,
                format: export::ExportFormat,
                path: String,
                options: Option<export::ExportOptions>,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(
                export::export_query(
                    app.clone(),
                    app.state(),
                    a.export_id,
                    a.conn_id,
                    a.database,
                    a.sql,
                    a.format,
                    a.path,
                    a.options,
                )
                .await?,
            )
        }
        "export_rows" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                path: String,
                format: export::ExportFormat,
                columns: Vec<db_core::ColumnMeta>,
                rows: Vec<db_core::Row>,
                options: Option<export::ExportOptions>,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(
                export::export_rows(app.clone(), a.path, a.format, a.columns, a.rows, a.options)
                    .await?,
            )
        }
        "kv_get" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                table: String,
                key: String,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(storage::kv_get(app.state(), a.table, a.key)?)
        }
        "kv_set" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                table: String,
                key: String,
                value: Value,
            }
            let a: Args = serde_json::from_value(args).map_err(|e| e.to_string())?;
            encode(storage::kv_set(app.state(), a.table, a.key, a.value)?)
        }
        "get_platform_capabilities" => {
            Ok(json!({"os":"web","isMobile":false,"backupSupported":true}))
        }
        "check_update" => Ok(Value::Null),
        _ => Err("Command is not available in web mode".to_string().into()),
    }
}
fn validate(app: &AppHandle, name: &str, args: &mut Value) -> CmdResult<()> {
    let state = app.state::<AppState>();
    if let Some(config) = args.get("config") {
        let c: db_core::ConnectionConfig =
            serde_json::from_value(config.clone()).map_err(|e| e.to_string())?;
        if uuid::Uuid::parse_str(&c.id).is_err() {
            return Err("Invalid connection id".to_string().into());
        }
        if c.engine == db_core::Engine::Sqlite {
            app.file_path(&c.database)?;
        }
    }
    if let Some(conn) = args.get("connId").and_then(Value::as_str) {
        let cfg = state.store.connection_for_connect(conn)?;
        if cfg.engine == db_core::Engine::Sqlite {
            app.file_path(&cfg.database)?;
            if name == "connect" {
                if let Some(db) = args.get("database").and_then(Value::as_str) {
                    if !db.is_empty() {
                        app.file_path(db)?;
                    }
                }
            }
        }
    }
    for key in ["path", "dest"] {
        if name != "set_backup_tool_path" {
            if let Some(p) = args.get(key).and_then(Value::as_str) {
                app.file_path(p)?;
            }
        }
    }
    if let Some(options) = args.get("options") {
        for key in ["input", "output"] {
            if let Some(p) = options.get(key).and_then(Value::as_str) {
                app.file_path(p)?;
            }
        }
    }
    if name == "kv_set" && args.get("key").and_then(Value::as_str) == Some("backup_tool_paths") {
        return Err("Use the validated tool settings command".to_string().into());
    }
    if name == "set_backup_tool_path" {
        let path = args.get("path").and_then(Value::as_str).unwrap_or("");
        let tool = args.get("name").and_then(Value::as_str).unwrap_or("");
        if !backup_tool_path(tool, path) {
            return Err("Choose an installed system database tool"
                .to_string()
                .into());
        }
    }
    if name == "run_query" || name == "export_query" {
        let queries = state.queries.lock().unwrap();
        let key = if name == "run_query" {
            "queryId"
        } else {
            "exportId"
        };
        let id = args.get(key).and_then(Value::as_str).unwrap_or("");
        if queries.len() >= 8 || queries.contains_key(id) {
            return Err("Query already active or concurrent query limit reached"
                .to_string()
                .into());
        }
    }
    if (name == "start_backup" || name == "start_restore") && state.jobs.lock().unwrap().len() >= 2
    {
        return Err("Wait for a backup job to finish".to_string().into());
    }
    Ok(())
}
fn backup_tool_path(tool: &str, path: &str) -> bool {
    let allowed = ["pg_dump", "pg_restore", "psql", "mysqldump", "mysql"];
    if !allowed.contains(&tool) {
        return false;
    }
    if path.is_empty() {
        return true;
    }
    let p = std::path::Path::new(path);
    let Some(base) = p.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let names = [
        tool,
        if tool == "mysqldump" {
            "mariadb-dump"
        } else if tool == "mysql" {
            "mariadb"
        } else {
            tool
        },
    ];
    names.contains(&base)
        && (p.parent() == Some(std::path::Path::new("/usr/bin"))
            || p.parent().is_some_and(|parent| {
                parent.to_string_lossy().starts_with("/usr/lib/postgresql/")
                    && parent.ends_with("bin")
            }))
        && !path.contains("..")
        && p.is_file()
}
