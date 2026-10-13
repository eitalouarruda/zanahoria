use std::collections::HashMap;
use std::process::Stdio;

use db_core::{ConnectionConfig, Engine};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::sniff::{DumpKind, SniffResult};
use crate::{BackupError, Result};

/// Proceso a ejecutar, ya resuelto (programa, args, env, redirecciones).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub program: String,
    pub args: Vec<String>,
    /// Password va por env (PGPASSWORD / MYSQL_PWD), nunca en argv.
    #[serde(skip)]
    pub envs: Vec<(String, String)>,
    /// mysqldump escribe el dump por stdout → archivo.
    pub stdout_to: Option<String>,
    /// mysql restaura leyendo el script por stdin.
    pub stdin_from: Option<String>,
    /// Versión mostrable del comando (sin password).
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobLine {
    Line { text: String },
    Done { success: bool, message: String },
}

pub struct JobHandle {
    pub lines: mpsc::Receiver<JobLine>,
    pub cancel: CancellationToken,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOptions {
    /// "custom" (pg -Fc) o "plain" (SQL).
    pub format: String,
    pub output: String,
    pub schema_only: bool,
    pub data_only: bool,
    /// Vacío = todas las tablas.
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOptions {
    pub input: String,
    pub target_db: String,
    pub clean: bool,
    pub single_transaction: bool,
}

fn tool_path(tools: &HashMap<String, String>, name: &str) -> Result<String> {
    tools
        .get(name)
        .cloned()
        .ok_or_else(|| BackupError::ToolNotFound(name.to_string()))
}

fn display(program: &str, args: &[String]) -> String {
    format!("{program} {}", args.join(" "))
}

pub fn build_backup_command(
    cfg: &ConnectionConfig,
    opts: &BackupOptions,
    tools: &HashMap<String, String>,
) -> Result<JobSpec> {
    match cfg.engine {
        Engine::Postgres => {
            let program = tool_path(tools, "pg_dump")?;
            let mut args = vec![
                "-h".into(),
                cfg.host.clone(),
                "-p".into(),
                cfg.port.unwrap_or(5432).to_string(),
                "-U".into(),
                cfg.user.clone(),
                "-d".into(),
                cfg.database.clone(),
                "--verbose".into(),
            ];
            if opts.format == "custom" {
                args.push("-Fc".into());
            }
            if opts.schema_only {
                args.push("--schema-only".into());
            }
            if opts.data_only {
                args.push("--data-only".into());
            }
            for table in &opts.tables {
                args.push("-t".into());
                args.push(table.clone());
            }
            args.push("-f".into());
            args.push(opts.output.clone());
            let d = display(&program, &args);
            Ok(JobSpec {
                program,
                args,
                envs: password_env(cfg),
                stdout_to: None,
                stdin_from: None,
                display: d,
            })
        }
        Engine::Mysql | Engine::Mariadb => {
            let program = tool_path(tools, "mysqldump")?;
            let mut args = vec![
                "-h".into(),
                cfg.host.clone(),
                "-P".into(),
                cfg.port.unwrap_or(3306).to_string(),
                "-u".into(),
                cfg.user.clone(),
                "--verbose".into(),
            ];
            if opts.schema_only {
                args.push("--no-data".into());
            }
            if opts.data_only {
                args.push("--no-create-info".into());
            }
            args.push(cfg.database.clone());
            args.extend(opts.tables.iter().cloned());
            let d = format!("{} > {}", display(&program, &args), opts.output);
            Ok(JobSpec {
                program,
                args,
                envs: password_env(cfg),
                stdout_to: Some(opts.output.clone()),
                stdin_from: None,
                display: d,
            })
        }
        Engine::Sqlite => Err(BackupError::Other(
            "sqlite backup uses VACUUM INTO, not an external tool".into(),
        )),
        Engine::Redis => Err(BackupError::Other("redis backup not supported".into())),
    }
}

pub fn build_restore_command(
    cfg: &ConnectionConfig,
    sniff: &SniffResult,
    opts: &RestoreOptions,
    tools: &HashMap<String, String>,
) -> Result<JobSpec> {
    match cfg.engine {
        Engine::Postgres => {
            let common = |args: &mut Vec<String>| {
                args.extend([
                    "-h".into(),
                    cfg.host.clone(),
                    "-p".into(),
                    cfg.port.unwrap_or(5432).to_string(),
                    "-U".into(),
                    cfg.user.clone(),
                    "-d".into(),
                    opts.target_db.clone(),
                ]);
            };
            match sniff.kind {
                DumpKind::PgCustom | DumpKind::PgTar | DumpKind::PgDirectory => {
                    let program = tool_path(tools, "pg_restore")?;
                    let mut args = vec!["--verbose".into(), "--no-owner".into()];
                    if opts.clean {
                        args.push("--clean".into());
                        args.push("--if-exists".into());
                    }
                    if opts.single_transaction {
                        args.push("--single-transaction".into());
                    }
                    common(&mut args);
                    args.push(opts.input.clone());
                    let d = display(&program, &args);
                    Ok(JobSpec {
                        program,
                        args,
                        envs: password_env(cfg),
                        stdout_to: None,
                        stdin_from: None,
                        display: d,
                    })
                }
                DumpKind::PlainSql => {
                    let program = tool_path(tools, "psql")?;
                    let mut args = vec!["-v".into(), "ON_ERROR_STOP=1".into()];
                    if opts.single_transaction {
                        args.push("--single-transaction".into());
                    }
                    common(&mut args);
                    args.push("-f".into());
                    args.push(opts.input.clone());
                    let d = display(&program, &args);
                    Ok(JobSpec {
                        program,
                        args,
                        envs: password_env(cfg),
                        stdout_to: None,
                        stdin_from: None,
                        display: d,
                    })
                }
                DumpKind::Unknown => {
                    Err(BackupError::Other("could not identify dump format".into()))
                }
            }
        }
        Engine::Mysql | Engine::Mariadb => {
            let program = tool_path(tools, "mysql")?;
            let args = vec![
                "-h".into(),
                cfg.host.clone(),
                "-P".into(),
                cfg.port.unwrap_or(3306).to_string(),
                "-u".into(),
                cfg.user.clone(),
                opts.target_db.clone(),
            ];
            let d = format!("{} < {}", display(&program, &args), opts.input);
            Ok(JobSpec {
                program,
                args,
                envs: password_env(cfg),
                stdout_to: None,
                stdin_from: Some(opts.input.clone()),
                display: d,
            })
        }
        _ => Err(BackupError::Other("unsupported engine for restore".into())),
    }
}

fn password_env(cfg: &ConnectionConfig) -> Vec<(String, String)> {
    let Some(pw) = &cfg.password else {
        return Vec::new();
    };
    match cfg.engine {
        Engine::Postgres => vec![("PGPASSWORD".into(), pw.clone())],
        Engine::Mysql | Engine::Mariadb => vec![("MYSQL_PWD".into(), pw.clone())],
        _ => Vec::new(),
    }
}

/// Ejecuta el job con streaming de stdout/stderr línea a línea y cancelación.
pub async fn run_job(spec: JobSpec) -> Result<JobHandle> {
    let (tx, rx) = mpsc::channel::<JobLine>(64);
    let cancel = CancellationToken::new();
    let cancel_task = cancel.clone();

    let mut cmd = tokio::process::Command::new(&spec.program);
    cmd.args(&spec.args)
        .envs(spec.envs.iter().cloned())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(out_path) = &spec.stdout_to {
        cmd.stdout(Stdio::from(std::fs::File::create(out_path)?));
    } else {
        cmd.stdout(Stdio::piped());
    }
    if let Some(in_path) = &spec.stdin_from {
        cmd.stdin(Stdio::from(std::fs::File::open(in_path)?));
    } else {
        cmd.stdin(Stdio::null());
    }

    let mut child = cmd.spawn()?;
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    tokio::spawn(async move {
        let tx_err = tx.clone();
        let stderr_task = tokio::spawn(async move {
            if let Some(stderr) = stderr {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if tx_err.send(JobLine::Line { text: line }).await.is_err() {
                        break;
                    }
                }
            }
        });
        let tx_out = tx.clone();
        let stdout_task = tokio::spawn(async move {
            if let Some(stdout) = stdout {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if tx_out.send(JobLine::Line { text: line }).await.is_err() {
                        break;
                    }
                }
            }
        });

        let status = tokio::select! {
            _ = cancel_task.cancelled() => {
                let _ = child.kill().await;
                let _ = tx.send(JobLine::Done { success: false, message: "cancelled".into() }).await;
                return;
            }
            status = child.wait() => status,
        };
        let _ = stderr_task.await;
        let _ = stdout_task.await;
        let (success, message) = match status {
            Ok(s) if s.success() => (true, "completed".to_string()),
            Ok(s) => (false, format!("exited with {s}")),
            Err(e) => (false, e.to_string()),
        };
        let _ = tx.send(JobLine::Done { success, message }).await;
    });

    Ok(JobHandle { lines: rx, cancel })
}
