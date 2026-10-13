use std::sync::Arc;

use redis::aio::ConnectionManager;
use tokio::sync::{mpsc, Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::config::ConnectionConfig;
use crate::driver::{ExecEvent, ExecOpts, ExecSummary, QueryStream};
use crate::error::{DbError, Result};
use crate::schema::{DbSchema, Namespace};
use crate::value::{ColumnMeta, DbValue, Row};

pub struct RedisEngine {
    manager: Arc<Mutex<ConnectionManager>>,
}

impl RedisEngine {
    pub async fn connect(cfg: &ConnectionConfig) -> Result<Self> {
        let scheme = if cfg.use_tls { "rediss" } else { "redis" };
        let auth = match (&cfg.user, &cfg.password) {
            (u, Some(p)) if !u.is_empty() => format!("{u}:{p}@"),
            (_, Some(p)) => format!(":{p}@"),
            _ => String::new(),
        };
        let db = if cfg.database.is_empty() {
            "0"
        } else {
            &cfg.database
        };
        let url = format!(
            "{scheme}://{auth}{}:{}/{db}",
            cfg.host,
            cfg.port.unwrap_or(6379)
        );
        let client = redis::Client::open(url).map_err(|e| DbError::Connection(e.to_string()))?;
        let manager = ConnectionManager::new(client)
            .await
            .map_err(|e| DbError::Connection(e.to_string()))?;
        Ok(Self {
            manager: Arc::new(Mutex::new(manager)),
        })
    }

    pub async fn ping(&self) -> Result<()> {
        let mut conn = self.manager.lock().await;
        redis::cmd("PING")
            .query_async::<String>(&mut *conn)
            .await
            .map_err(|e| DbError::Connection(e.to_string()))?;
        Ok(())
    }

    pub async fn disconnect(&self) {
        // ConnectionManager cierra al hacer drop.
    }

    /// Ejecuta un comando Redis escrito como línea de texto (`GET foo`,
    /// `SCAN 0 MATCH user:*`) y lo presenta como resultado tabular.
    pub fn execute(&self, input: String, _opts: ExecOpts) -> QueryStream {
        let (tx, rx) = mpsc::channel::<Result<ExecEvent>>(16);
        let cancel = CancellationToken::new();
        let resume = Arc::new(Notify::new());
        let manager = self.manager.clone();
        let cancel_task = cancel.clone();

        tokio::spawn(async move {
            let parts = match shell_split(&input) {
                Ok(p) if !p.is_empty() => p,
                Ok(_) => {
                    let _ = tx.send(Err(DbError::Query("empty command".into()))).await;
                    return;
                }
                Err(e) => {
                    let _ = tx.send(Err(DbError::Query(e))).await;
                    return;
                }
            };
            let mut cmd = redis::cmd(&parts[0]);
            for arg in &parts[1..] {
                cmd.arg(arg);
            }
            let result = {
                let mut conn = manager.lock().await;
                tokio::select! {
                    _ = cancel_task.cancelled() => return,
                    r = cmd.query_async::<redis::Value>(&mut *conn) => r,
                }
            };
            match result {
                Ok(value) => {
                    let rows = value_to_rows(&value);
                    let total = rows.len() as u64;
                    let _ = tx
                        .send(Ok(ExecEvent::Columns {
                            columns: vec![
                                ColumnMeta {
                                    name: "#".into(),
                                    db_type: "index".into(),
                                },
                                ColumnMeta {
                                    name: "value".into(),
                                    db_type: "redis".into(),
                                },
                            ],
                        }))
                        .await;
                    let _ = tx.send(Ok(ExecEvent::Rows { rows })).await;
                    let _ = tx
                        .send(Ok(ExecEvent::Done {
                            summary: ExecSummary {
                                affected: None,
                                truncated: false,
                                total_rows: total,
                            },
                        }))
                        .await;
                }
                Err(e) => {
                    let _ = tx.send(Err(DbError::Query(e.to_string()))).await;
                }
            }
        });

        QueryStream {
            events: rx,
            cancel,
            resume,
        }
    }

    pub async fn list_databases(&self) -> Result<Vec<String>> {
        let mut conn = self.manager.lock().await;
        let databases: i64 = redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async::<Vec<String>>(&mut *conn)
            .await
            .ok()
            .and_then(|v| v.get(1).and_then(|n| n.parse().ok()))
            .unwrap_or(16);
        Ok((0..databases).map(|i| i.to_string()).collect())
    }

    pub async fn introspect(&self) -> Result<DbSchema> {
        Ok(DbSchema {
            namespaces: vec![Namespace {
                name: "keys".into(),
                tables: Vec::new(),
            }],
        })
    }
}

/// Aplana un redis::Value a filas [índice, texto].
fn value_to_rows(value: &redis::Value) -> Vec<Row> {
    fn to_text(v: &redis::Value) -> String {
        match v {
            redis::Value::Nil => "(nil)".into(),
            redis::Value::Int(i) => i.to_string(),
            redis::Value::SimpleString(s) => s.clone(),
            redis::Value::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
            redis::Value::Okay => "OK".into(),
            redis::Value::Double(d) => d.to_string(),
            redis::Value::Boolean(b) => b.to_string(),
            other => format!("{other:?}"),
        }
    }
    fn flatten(v: &redis::Value, out: &mut Vec<String>) {
        match v {
            redis::Value::Array(items) | redis::Value::Set(items) => {
                for item in items {
                    flatten(item, out);
                }
            }
            redis::Value::Map(pairs) => {
                for (k, val) in pairs {
                    out.push(format!("{} => {}", to_text(k), to_text(val)));
                }
            }
            other => out.push(to_text(other)),
        }
    }
    let mut flat = Vec::new();
    flatten(value, &mut flat);
    flat.into_iter()
        .enumerate()
        .map(|(i, text)| vec![DbValue::Int(i as i64 + 1), DbValue::Text(text)])
        .collect()
}

/// Split estilo shell con soporte de comillas simples y dobles.
fn shell_split(input: &str) -> std::result::Result<Vec<String>, String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut has_token = false;
    for ch in input.trim().chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
                has_token = true;
            }
            None if ch.is_whitespace() => {
                if has_token {
                    parts.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            None => {
                current.push(ch);
                has_token = true;
            }
        }
    }
    if quote.is_some() {
        return Err("unclosed quote".into());
    }
    if has_token {
        parts.push(current);
    }
    Ok(parts)
}
