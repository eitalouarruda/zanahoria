use std::collections::HashMap;
use std::io::Read;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use db_core::{ConnectionConfig, Engine};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::compat::SqlFilter;
use crate::plan::{RestorePlan, Strategy};
use crate::sniff::DumpKind;
use crate::{BackupError, Result};

/// Cómo medir el avance de un job (unidades en `JobStats::progress_*`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Progress {
    #[default]
    None,
    /// Una unidad por línea de salida que contiene el texto
    /// (p. ej. "processing data for table" de pg_restore --verbose).
    OutputLines(&'static str),
    /// Una unidad por bloque COPY que pasa por el filtro.
    Copies,
    /// Bytes leídos del archivo de entrada (el total lo pone el runner).
    InputBytes,
}

/// Origen del script que se le pasa por stdin al programa principal.
#[derive(Debug, Clone)]
pub enum Feed {
    /// Proceso cuya salida es el script (`pg_restore -f -`).
    Process { program: String, args: Vec<String> },
    /// Archivo SQL; gzip se descomprime al vuelo.
    File { path: String, gzip: bool },
}

/// Proceso a ejecutar, ya resuelto (programa, args, env, redirecciones).
#[derive(Debug, Clone, Serialize)]
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
    /// Script por stdin pasando por `filter` (tiene prioridad sobre stdin_from).
    #[serde(skip)]
    pub feed: Option<Feed>,
    #[serde(skip)]
    pub filter: Option<SqlFilter>,
    #[serde(skip)]
    pub progress: Progress,
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
    pub stats: Arc<JobStats>,
}

/// Contadores del job, válidos cuando llega `JobLine::Done`.
#[derive(Debug, Default)]
pub struct JobStats {
    /// Líneas de error en la salida (psql sigue tras errores sin ON_ERROR_STOP).
    pub errors: AtomicUsize,
    /// CREATE TABLE que pasaron por el filtro (0 si no hubo filtro).
    pub tables_seen: AtomicUsize,
    /// Avance: unidades hechas / total (0 = desconocido).
    pub progress_done: AtomicU64,
    pub progress_total: AtomicU64,
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
    /// Database a respaldar; None = la de la conexión.
    #[serde(default)]
    pub database: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RestoreOptions {
    pub input: String,
    pub target_db: String,
    pub clean: bool,
    pub single_transaction: bool,
    /// Crear la database destino si no existe.
    pub create_db: bool,
    /// Seguir tras errores (psql sin ON_ERROR_STOP / mysql --force). El job
    /// igual termina como fallido si hubo errores.
    pub continue_on_error: bool,
    /// Restaurar GRANT/REVOKE. Por defecto no: los roles del servidor de
    /// origen casi nunca existen en el destino y harían fallar el restore.
    pub keep_privileges: bool,
}

impl Default for RestoreOptions {
    fn default() -> Self {
        Self {
            input: String::new(),
            target_db: String::new(),
            clean: false,
            single_transaction: true,
            create_db: true,
            continue_on_error: false,
            keep_privileges: false,
        }
    }
}

fn tool_path(tools: &HashMap<String, String>, name: &str) -> Result<String> {
    tools
        .get(name)
        .cloned()
        .ok_or_else(|| BackupError::ToolNotFound(name.to_string()))
}

fn display(program: &str, args: &[String]) -> String {
    let quoted: Vec<String> = args
        .iter()
        .map(|a| {
            if a.contains(char::is_whitespace) {
                format!("\"{a}\"")
            } else {
                a.clone()
            }
        })
        .collect();
    format!("{program} {}", quoted.join(" "))
}

pub fn build_backup_command(
    cfg: &ConnectionConfig,
    opts: &BackupOptions,
    tools: &HashMap<String, String>,
) -> Result<JobSpec> {
    let database = opts
        .database
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| cfg.database.clone());
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
                database,
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
                feed: None,
                filter: None,
                progress: Progress::OutputLines("dumping contents of table"),
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
            args.push(database);
            args.extend(opts.tables.iter().cloned());
            let d = format!("{} > {}", display(&program, &args), opts.output);
            Ok(JobSpec {
                program,
                args,
                envs: password_env(cfg),
                stdout_to: Some(opts.output.clone()),
                stdin_from: None,
                feed: None,
                filter: None,
                progress: Progress::OutputLines("Sending SELECT query"),
                display: d,
            })
        }
        Engine::Sqlite => Err(BackupError::Other(
            "sqlite backup uses VACUUM INTO, not an external tool".into(),
        )),
        Engine::Redis => Err(BackupError::Other("redis backup not supported".into())),
    }
}

/// Arma el job de restore según el plan (ver `plan_restore`).
pub fn build_restore_command(
    cfg: &ConnectionConfig,
    plan: &RestorePlan,
    opts: &RestoreOptions,
    tools: &HashMap<String, String>,
) -> Result<JobSpec> {
    if let Some(blocker) = &plan.blocker {
        return Err(BackupError::Other(format!(
            "restore blocked: {} {:?}",
            blocker.code, blocker.params
        )));
    }
    let gzip = plan.sniff.compressed;
    match cfg.engine {
        Engine::Postgres => {
            let conn_args = vec![
                "-h".to_string(),
                cfg.host.clone(),
                "-p".into(),
                cfg.port.unwrap_or(5432).to_string(),
                "-U".into(),
                cfg.user.clone(),
                "-d".into(),
                opts.target_db.clone(),
            ];
            let restore_flags = || {
                let mut args = vec!["--no-owner".to_string()];
                if !opts.keep_privileges {
                    args.push("--no-privileges".into());
                }
                if opts.clean {
                    args.push("--clean".into());
                    args.push("--if-exists".into());
                }
                args
            };
            if plan.strategy == Strategy::Direct {
                let program = tool_path(tools, "pg_restore")?;
                let mut args = vec!["--verbose".to_string()];
                args.extend(restore_flags());
                if opts.single_transaction {
                    args.push("--single-transaction".into());
                } else if plan.sniff.kind != DumpKind::PgTar {
                    // -j no admite tar ni --single-transaction.
                    let jobs = std::thread::available_parallelism()
                        .map(|n| n.get().clamp(1, 4))
                        .unwrap_or(2);
                    args.push(format!("--jobs={jobs}"));
                }
                if opts.continue_on_error {
                    // pg_restore sigue por defecto; el fallo se reporta al final.
                } else {
                    args.push("--exit-on-error".into());
                }
                args.extend(conn_args);
                args.push(opts.input.clone());
                let d = display(&program, &args);
                return Ok(JobSpec {
                    program,
                    args,
                    envs: password_env(cfg),
                    stdout_to: None,
                    stdin_from: None,
                    feed: None,
                    filter: None,
                    progress: Progress::OutputLines("processing data for table"),
                    display: d,
                });
            }

            // Compat / Script: el SQL pasa por el filtro y lo ejecuta psql.
            let psql = tool_path(tools, "psql")?;
            let progress = if plan.strategy == Strategy::Compat {
                Progress::Copies
            } else {
                Progress::InputBytes
            };
            let (feed, feed_display) = if plan.strategy == Strategy::Compat {
                let program = tool_path(tools, "pg_restore")?;
                let mut args = restore_flags();
                args.extend(["-f".into(), "-".into(), opts.input.clone()]);
                let d = display(&program, &args);
                (Feed::Process { program, args }, d)
            } else {
                let d = if gzip {
                    display("gzip -dc", std::slice::from_ref(&opts.input))
                } else {
                    display("cat", std::slice::from_ref(&opts.input))
                };
                (
                    Feed::File {
                        path: opts.input.clone(),
                        gzip,
                    },
                    d,
                )
            };
            let mut args = vec![
                "-X".to_string(),
                "-q".into(),
                "-v".into(),
                format!(
                    "ON_ERROR_STOP={}",
                    if opts.continue_on_error { 0 } else { 1 }
                ),
            ];
            if opts.single_transaction && !opts.continue_on_error {
                args.push("--single-transaction".into());
            }
            args.extend(conn_args);
            args.extend(["-f".into(), "-".into()]);
            let d = format!(
                "{feed_display} | [compat filter] | {}",
                display(&psql, &args)
            );
            Ok(JobSpec {
                program: psql,
                args,
                envs: password_env(cfg),
                stdout_to: None,
                stdin_from: None,
                feed: Some(feed),
                filter: plan.filter.clone(),
                progress,
                display: d,
            })
        }
        Engine::Mysql | Engine::Mariadb => {
            let program = tool_path(tools, "mysql")?;
            let mut args = vec![
                "-h".into(),
                cfg.host.clone(),
                "-P".into(),
                cfg.port.unwrap_or(3306).to_string(),
                "-u".into(),
                cfg.user.clone(),
            ];
            if opts.continue_on_error {
                args.push("--force".into());
            }
            args.push(opts.target_db.clone());
            let d = format!("{} < {}", display(&program, &args), opts.input);
            Ok(JobSpec {
                program,
                args,
                envs: password_env(cfg),
                stdout_to: None,
                stdin_from: None,
                feed: Some(Feed::File {
                    path: opts.input.clone(),
                    gzip,
                }),
                filter: plan.filter.clone(),
                progress: Progress::InputBytes,
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

/// Entradas del TOC de un archive (`pg_restore -l`).
#[derive(Debug, Clone, Copy, Default)]
pub struct TocCounts {
    /// Tablas que crea (verificación).
    pub tables: usize,
    /// Tablas con datos (progreso).
    pub data: usize,
}

/// Lee el TOC de un archive con `pg_restore -l`. None si no se pudo leer
/// (archive dañado o pg_restore incompatible).
pub async fn archive_toc(pg_restore: &str, input: &str) -> Option<TocCounts> {
    let output = tokio::process::Command::new(pg_restore)
        .arg("-l")
        .arg(input)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut counts = TocCounts::default();
    for line in text.lines().filter(|l| !l.starts_with(';')) {
        // "215; 1259 16388 TABLE public foo postgres" / "… TABLE DATA public foo …"
        let mut it = line.split_whitespace().skip(3);
        if it.next() != Some("TABLE") {
            continue;
        }
        match it.next() {
            Some("DATA") => counts.data += 1,
            Some("ATTACH") => {}
            _ => counts.tables += 1,
        }
    }
    Some(counts)
}

/// Comprueba que un respaldo terminado esté completo: los archives se leen
/// con pg_restore; los SQL planos deben terminar con la marca de fin del
/// dump (pg_dump y mysqldump la escriben solo si terminaron bien).
pub async fn verify_backup(
    path: &str,
    pg_restore: Option<&str>,
) -> std::result::Result<String, String> {
    let sniff = crate::sniff_dump(path).map_err(|e| e.to_string())?;
    match sniff.kind {
        DumpKind::PgCustom | DumpKind::PgTar | DumpKind::PgDirectory => {
            let Some(tool) = pg_restore else {
                return Ok("file written (pg_restore not available to verify)".into());
            };
            // `pg_restore -l` solo lee el TOC del principio: un archivo cortado
            // pasaría. Leerlo entero (SQL descartado) detecta datos truncados.
            let full_read = tokio::process::Command::new(tool)
                .args(["-f", "-", path])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .map_err(|e| e.to_string())?;
            let toc = archive_toc(tool, path)
                .await
                .filter(|_| full_read.success())
                .ok_or_else(|| "the backup file cannot be read back by pg_restore".to_string())?;
            Ok(format!(
                "backup verified: {} tables, {} with data",
                toc.tables, toc.data
            ))
        }
        DumpKind::PlainSql => {
            let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
            let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            let mut tail = Vec::new();
            use std::io::Seek;
            file.seek(std::io::SeekFrom::Start(size.saturating_sub(4096)))
                .map_err(|e| e.to_string())?;
            file.read_to_end(&mut tail).map_err(|e| e.to_string())?;
            let tail = String::from_utf8_lossy(&tail);
            if tail.contains("database dump complete") || tail.contains("Dump completed") {
                Ok("backup verified: dump is complete".into())
            } else {
                Err("the backup file looks incomplete (no end-of-dump marker)".into())
            }
        }
        DumpKind::Unknown => Err("the backup file was not recognized".into()),
    }
}

/// ¿La línea de salida reporta un error? (psql, pg_restore, mysql)
fn is_error_line(line: &str) -> bool {
    line.contains("ERROR:") || line.contains(": error:") || line.starts_with("ERROR ")
}

const CHUNK: usize = 64 * 1024;

/// Resultado del productor del pipeline.
struct FeedOutcome {
    filter: Option<SqlFilter>,
    /// Fallo del proceso/archivo de origen (p. ej. pg_restore no pudo leer).
    failure: Option<String>,
}

/// Lee el script (proceso o archivo), lo filtra y lo manda en bloques.
#[allow(clippy::too_many_arguments)]
async fn produce(
    feed: Feed,
    mut filter: Option<SqlFilter>,
    progress: Progress,
    envs: Vec<(String, String)>,
    chunks: mpsc::Sender<Vec<u8>>,
    lines: mpsc::Sender<JobLine>,
    stats: Arc<JobStats>,
) -> FeedOutcome {
    let push = |filter: &mut Option<SqlFilter>, line: &[u8], out: &mut Vec<u8>| match filter {
        Some(f) => {
            if let Some(l) = f.apply(line) {
                out.extend_from_slice(&l);
            }
        }
        None => out.extend_from_slice(line),
    };
    match feed {
        Feed::Process { program, args } => {
            let mut cmd = tokio::process::Command::new(&program);
            cmd.args(&args)
                .envs(envs)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    return FeedOutcome {
                        filter,
                        failure: Some(format!("{program}: {e}")),
                    }
                }
            };
            if let Some(stderr) = child.stderr.take() {
                let lines = lines.clone();
                let stats = stats.clone();
                tokio::spawn(async move {
                    let mut it = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = it.next_line().await {
                        if is_error_line(&line) {
                            stats.errors.fetch_add(1, Ordering::Relaxed);
                        }
                        let _ = lines.send(JobLine::Line { text: line }).await;
                    }
                });
            }
            let mut reader = BufReader::with_capacity(CHUNK, child.stdout.take().unwrap());
            let mut buf = Vec::new();
            let mut out = Vec::with_capacity(CHUNK);
            let mut closed = false;
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {
                        push(&mut filter, &buf, &mut out);
                        if progress == Progress::Copies {
                            if let Some(f) = &filter {
                                stats
                                    .progress_done
                                    .store(f.copies_seen() as u64, Ordering::Relaxed);
                            }
                        }
                    }
                    Err(e) => {
                        return FeedOutcome {
                            filter,
                            failure: Some(e.to_string()),
                        }
                    }
                }
                if out.len() >= CHUNK && chunks.send(std::mem::take(&mut out)).await.is_err() {
                    closed = true;
                    break;
                }
            }
            if !closed && !out.is_empty() {
                let _ = chunks.send(out).await;
            }
            drop(chunks);
            if closed {
                // El consumidor murió (psql falló/cancelado): no esperar al origen.
                let _ = child.kill().await;
                return FeedOutcome {
                    filter,
                    failure: None,
                };
            }
            let failure = match child.wait().await {
                Ok(s) if s.success() => None,
                Ok(s) => Some(format!("{program} exited with {s}")),
                Err(e) => Some(e.to_string()),
            };
            FeedOutcome { filter, failure }
        }
        Feed::File { path, gzip } => {
            // Lectura bloqueante (flate2) en un hilo aparte.
            let stats = stats.clone();
            let joined = tokio::task::spawn_blocking(move || {
                use std::io::BufRead;
                let file = match std::fs::File::open(&path) {
                    Ok(f) => CountingReader {
                        inner: f,
                        stats: stats.clone(),
                    },
                    Err(e) => return (filter, Some(format!("{path}: {e}"))),
                };
                let mut reader: Box<dyn BufRead> = if gzip {
                    Box::new(std::io::BufReader::with_capacity(
                        CHUNK,
                        flate2::read::MultiGzDecoder::new(file),
                    ))
                } else {
                    Box::new(std::io::BufReader::with_capacity(CHUNK, file))
                };
                let mut buf = Vec::new();
                let mut out = Vec::with_capacity(CHUNK);
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) => break,
                        Ok(_) => push(&mut filter, &buf, &mut out),
                        Err(e) => return (filter, Some(e.to_string())),
                    }
                    if out.len() >= CHUNK && chunks.blocking_send(std::mem::take(&mut out)).is_err()
                    {
                        return (filter, None);
                    }
                }
                if !out.is_empty() {
                    let _ = chunks.blocking_send(out);
                }
                (filter, None)
            })
            .await;
            match joined {
                Ok((filter, failure)) => FeedOutcome { filter, failure },
                Err(e) => FeedOutcome {
                    filter: None,
                    failure: Some(e.to_string()),
                },
            }
        }
    }
}

/// Cuenta los bytes leídos del archivo de entrada (progreso).
struct CountingReader {
    inner: std::fs::File,
    stats: Arc<JobStats>,
}

impl Read for CountingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.stats
            .progress_done
            .fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

/// Resume las correcciones aplicadas por el filtro para el log.
fn filter_summary(filter: &SqlFilter) -> Option<String> {
    let applied = filter.applied();
    if applied.is_empty() {
        return None;
    }
    let parts: Vec<String> = applied.iter().map(|(k, n)| format!("{k} ×{n}")).collect();
    Some(format!("compat fixes applied: {}", parts.join(", ")))
}

/// Ejecuta el job con streaming de stdout/stderr línea a línea y cancelación.
/// Con `feed`, el script pasa por el filtro hacia el stdin del programa.
pub async fn run_job(spec: JobSpec) -> Result<JobHandle> {
    let (tx, rx) = mpsc::channel::<JobLine>(64);
    let cancel = CancellationToken::new();
    let cancel_task = cancel.clone();
    let stats = Arc::new(JobStats::default());

    let mut cmd = tokio::process::Command::new(&spec.program);
    cmd.args(&spec.args)
        .envs(spec.envs.iter().cloned())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(out_path) = &spec.stdout_to {
        cmd.stdout(Stdio::from(std::fs::File::create(out_path)?));
    } else if spec.feed.is_some() {
        // psql/mysql ejecutando un script: su stdout son solo resultados
        // (p. ej. un `setval` por secuencia); los errores van por stderr.
        cmd.stdout(Stdio::null());
    } else {
        cmd.stdout(Stdio::piped());
    }
    if spec.feed.is_some() {
        cmd.stdin(Stdio::piped());
    } else if let Some(in_path) = &spec.stdin_from {
        cmd.stdin(Stdio::from(std::fs::File::open(in_path)?));
    } else {
        cmd.stdin(Stdio::null());
    }

    if spec.progress == Progress::InputBytes {
        if let Some(Feed::File { path, .. }) = &spec.feed {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            stats.progress_total.store(size, Ordering::Relaxed);
        }
    }

    let mut child = cmd.spawn()?;
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    // Pipeline: productor (origen + filtro) → canal → stdin del programa.
    let feeder = spec.feed.clone().map(|feed| {
        let (chunk_tx, mut chunk_rx) = mpsc::channel::<Vec<u8>>(16);
        let mut stdin = child.stdin.take().expect("stdin piped");
        let writer = tokio::spawn(async move {
            while let Some(chunk) = chunk_rx.recv().await {
                if stdin.write_all(&chunk).await.is_err() {
                    break;
                }
            }
            // drop(stdin) → EOF para el programa.
        });
        let producer = tokio::spawn(produce(
            feed,
            spec.filter.clone(),
            spec.progress,
            spec.envs.clone(),
            chunk_tx,
            tx.clone(),
            stats.clone(),
        ));
        (producer, writer)
    });

    let stats_task = stats.clone();
    let progress_marker = match spec.progress {
        Progress::OutputLines(marker) => Some(marker),
        _ => None,
    };
    tokio::spawn(async move {
        let forward = |stream: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>,
                       tx: mpsc::Sender<JobLine>,
                       stats: Arc<JobStats>| {
            tokio::spawn(async move {
                if let Some(stream) = stream {
                    let mut lines = BufReader::new(stream).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        if is_error_line(&line) {
                            stats.errors.fetch_add(1, Ordering::Relaxed);
                        }
                        if progress_marker.is_some_and(|m| line.contains(m)) {
                            stats.progress_done.fetch_add(1, Ordering::Relaxed);
                        }
                        if tx.send(JobLine::Line { text: line }).await.is_err() {
                            break;
                        }
                    }
                }
            })
        };
        let stderr_task = forward(
            stderr.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            tx.clone(),
            stats_task.clone(),
        );
        let stdout_task = forward(
            stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            tx.clone(),
            stats_task.clone(),
        );

        let status = tokio::select! {
            _ = cancel_task.cancelled() => {
                let _ = child.kill().await;
                if let Some((producer, writer)) = feeder {
                    producer.abort();
                    writer.abort();
                }
                let _ = tx.send(JobLine::Done { success: false, message: "cancelled".into() }).await;
                return;
            }
            status = child.wait() => status,
        };
        let mut feed_failure = None;
        if let Some((producer, writer)) = feeder {
            writer.abort();
            if let Ok(outcome) = producer.await {
                feed_failure = outcome.failure;
                if let Some(filter) = outcome.filter {
                    stats_task
                        .tables_seen
                        .store(filter.tables_seen(), Ordering::Relaxed);
                    if let Some(summary) = filter_summary(&filter) {
                        let _ = tx.send(JobLine::Line { text: summary }).await;
                    }
                }
            }
        }
        let _ = stderr_task.await;
        let _ = stdout_task.await;
        let errors = stats_task.errors.load(Ordering::Relaxed);
        let (success, message) = match status {
            Ok(s) if !s.success() => (false, format!("exited with {s}")),
            Err(e) => (false, e.to_string()),
            Ok(_) if feed_failure.is_some() => (false, feed_failure.unwrap_or_default()),
            // Terminar con exit 0 no basta: errores en la salida = fallo.
            Ok(_) if errors > 0 => (false, format!("completed with {errors} errors")),
            Ok(_) => (true, "completed".to_string()),
        };
        let _ = tx.send(JobLine::Done { success, message }).await;
    });

    Ok(JobHandle {
        lines: rx,
        cancel,
        stats,
    })
}
