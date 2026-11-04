#![cfg(unix)]
mod commands;
#[path = "../../../src/error.rs"]
mod error;
mod rpc;
mod runtime;
#[path = "../../../src/state.rs"]
mod state;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path as RoutePath, Query, Request, State,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use runtime::AppHandle;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncWriteExt;
struct Client {
    app: AppHandle,
    seen: AtomicU64,
}
struct Server {
    store: Arc<app_store::AppStore>,
    files: PathBuf,
    clients: Mutex<HashMap<String, Arc<Client>>>,
    gate: Mutex<Gate>,
    uploads: Mutex<HashSet<(String, String)>>,
}
struct Gate {
    maintenance: bool,
    active: usize,
}
struct Lease(Arc<Server>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.gate.lock().unwrap().active -= 1;
    }
}
fn enter(s: &Shared) -> Result<Lease> {
    let mut g = s.gate.lock().unwrap();
    if g.maintenance {
        return Err(failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Backup in progress; try again shortly",
        ));
    }
    g.active += 1;
    Ok(Lease(s.clone()))
}
async fn quiesce(State(s): State<Shared>) -> Result<Json<Value>> {
    let mut g = s.gate.lock().unwrap();
    if g.maintenance {
        return Err(failure(StatusCode::CONFLICT, "Already quiesced"));
    }
    g.maintenance = true;
    if g.active > 0 || s.clients.lock().unwrap().values().any(|c| c.app.busy()) {
        g.maintenance = false;
        return Err(failure(
            StatusCode::CONFLICT,
            "Zanahoria has active operations; backup postponed",
        ));
    }
    Ok(Json(json!({"quiesced":true})))
}
async fn resume(State(s): State<Shared>) -> Json<Value> {
    s.gate.lock().unwrap().maintenance = false;
    Json(json!({"quiesced":false}))
}
type Shared = Arc<Server>;
type Result<T> = std::result::Result<T, (StatusCode, Json<Value>)>;
fn failure(status: StatusCode, message: impl ToString) -> (StatusCode, Json<Value>) {
    (status, Json(json!({"message":message.to_string()})))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn client(server: &Shared, id: &str) -> Result<Arc<Client>> {
    let c = server
        .clients
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| failure(StatusCode::GONE, "Web session expired; reload Zanahoria"))?;
    c.seen.store(now(), Ordering::Relaxed);
    Ok(c)
}
async fn new_client(State(s): State<Shared>) -> Result<Json<Value>> {
    let _lease = enter(&s)?;
    let mut clients = s.clients.lock().unwrap();
    clients.retain(|_, c| {
        if now().saturating_sub(c.seen.load(Ordering::Relaxed)) >= 43200 {
            c.app.cancel();
            false
        } else {
            true
        }
    });
    if clients.len() >= 32 {
        return Err(failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many open web sessions",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let app = AppHandle::new(s.store.clone(), s.files.clone());
    clients.insert(
        id.clone(),
        Arc::new(Client {
            app,
            seen: AtomicU64::new(now()),
        }),
    );
    Ok(Json(json!({"id":id})))
}
async fn call(
    State(s): State<Shared>,
    RoutePath((id, command)): RoutePath<(String, String)>,
    Json(args): Json<Value>,
) -> Result<Json<Value>> {
    let _lease = enter(&s)?;
    let c = client(&s, &id)?;
    let result = rpc::dispatch(&c.app, &command, args)
        .await
        .map_err(|e| failure(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(result))
}
#[derive(Deserialize, Default)]
struct Cursor {
    #[serde(default)]
    after: u64,
}
async fn events(
    State(s): State<Shared>,
    RoutePath(id): RoutePath<String>,
    Query(cursor): Query<Cursor>,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let c = client(&s, &id)?;
    Ok(ws
        .max_message_size(4096)
        .on_upgrade(move |ws| stream(ws, c, cursor.after)))
}
async fn stream(ws: WebSocket, c: Arc<Client>, mut after: u64) {
    let (mut out, mut input) = ws.split();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            _=tick.tick()=>{
                c.seen.store(now(),Ordering::Relaxed);
                let (events,gap)=c.app.events_after(after);
                if gap {let _=out.send(Message::Text(json!({"type":"gap","message":"Event history expired; refresh query results before continuing"}).to_string().into())).await;break}
                for event in events {after=event.seq;if out.send(Message::Text(serde_json::to_string(&event).unwrap().into())).await.is_err(){return}}
            },
            msg=input.next()=>{if !matches!(msg,Some(Ok(Message::Text(_)|Message::Ping(_)|Message::Pong(_)))){break}}
        }
    }
}
#[derive(Deserialize)]
struct FileRequest {
    name: String,
}
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("file");
    let clean: String = base
        .chars()
        .take(120)
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    if clean.is_empty() {
        "file".into()
    } else {
        clean
    }
}
async fn allocate(
    State(s): State<Shared>,
    RoutePath(id): RoutePath<String>,
    Json(req): Json<FileRequest>,
) -> Result<Json<Value>> {
    let _lease = enter(&s)?;
    client(&s, &id)?;
    let name = format!("{}-{}", uuid::Uuid::new_v4(), safe_name(&req.name));
    let path = s.files.join(&name);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| failure(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    s.uploads.lock().unwrap().insert((id, name.clone()));
    Ok(Json(json!({"path":path,"name":name})))
}
fn file_path(s: &Shared, name: &str) -> Result<PathBuf> {
    if !runtime::valid_file_name(name) {
        return Err(failure(StatusCode::BAD_REQUEST, "Invalid file name"));
    }
    let p = s.files.join(name);
    if p.symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(failure(StatusCode::FORBIDDEN, "Symlinks are not allowed"));
    }
    Ok(p)
}
async fn files(State(s): State<Shared>, RoutePath(id): RoutePath<String>) -> Result<Json<Value>> {
    client(&s, &id)?;
    let mut result = Vec::new();
    for entry in std::fs::read_dir(&s.files)
        .map_err(|e| failure(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !runtime::valid_file_name(&name) {
            continue;
        }
        let Ok(m) = entry.metadata() else { continue };
        if !m.is_file() || entry.file_type().is_ok_and(|t| t.is_symlink()) {
            continue;
        }
        result.push(json!({"name":name,"path":entry.path(),"size":m.len()}));
    }
    Ok(Json(Value::Array(result)))
}
struct UploadGuard {
    path: PathBuf,
    finished: bool,
}
impl Drop for UploadGuard {
    fn drop(&mut self) {
        if !self.finished {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
async fn upload(
    State(s): State<Shared>,
    RoutePath((id, name)): RoutePath<(String, String)>,
    request: Request,
) -> Result<Json<Value>> {
    let _lease = enter(&s)?;
    client(&s, &id)?;
    let path = file_path(&s, &name)?;
    if !s.uploads.lock().unwrap().remove(&(id, name.clone())) {
        return Err(failure(
            StatusCode::CONFLICT,
            "Allocate a new file before uploading",
        ));
    }
    let m = std::fs::metadata(&path).map_err(|e| failure(StatusCode::NOT_FOUND, e))?;
    if m.len() != 0 {
        return Err(failure(
            StatusCode::CONFLICT,
            "Uploads cannot replace an existing file",
        ));
    }
    let mut guard = UploadGuard {
        path: path.clone(),
        finished: false,
    };
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .await
        .map_err(|e| failure(StatusCode::BAD_REQUEST, e))?;
    let mut stream = request.into_body().into_data_stream();
    let mut size = 0usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| failure(StatusCode::BAD_REQUEST, e))?;
        size += chunk.len();
        if size > 1024 * 1024 * 1024 {
            drop(file);
            let _ = tokio::fs::remove_file(path).await;
            return Err(failure(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Upload exceeds 1 GiB",
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| failure(StatusCode::INSUFFICIENT_STORAGE, e))?;
    }
    file.sync_all()
        .await
        .map_err(|e| failure(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    guard.finished = true;
    Ok(Json(json!({"path":path,"size":size})))
}
struct DownloadStream {
    reader: tokio_util::io::ReaderStream<tokio::fs::File>,
    temporary: Option<PathBuf>,
}
impl futures::Stream for DownloadStream {
    type Item = std::result::Result<axum::body::Bytes, std::io::Error>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.reader.poll_next_unpin(cx)
    }
}
impl Drop for DownloadStream {
    fn drop(&mut self) {
        if let Some(path) = self.temporary.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}
async fn download(
    State(s): State<Shared>,
    RoutePath((id, name)): RoutePath<(String, String)>,
) -> Result<Response> {
    let _lease = enter(&s)?;
    client(&s, &id)?;
    let path = file_path(&s, &name)?;
    let mut actual = path.clone();
    let mut temporary = None;
    if let Some(config) = s
        .store
        .list_connections()
        .map_err(|e| failure(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .into_iter()
        .find(|c| {
            c.config.engine == db_core::Engine::Sqlite && Path::new(&c.config.database) == path
        })
    {
        let directory = s
            .files
            .parent()
            .expect("files directory")
            .join(".downloads");
        std::fs::create_dir_all(&directory)
            .map_err(|e| failure(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        actual = directory.join(format!("{}.sqlite", uuid::Uuid::new_v4()));
        let handle = db_core::EngineHandle::connect(&config.config, 1)
            .await
            .map_err(|e| failure(StatusCode::BAD_REQUEST, e))?;
        let result = handle.sqlite_vacuum_into(&actual.to_string_lossy()).await;
        handle.disconnect().await;
        result.map_err(|e| failure(StatusCode::BAD_REQUEST, e))?;
        temporary = Some(actual.clone());
    }
    let file = tokio::fs::File::open(actual)
        .await
        .map_err(|e| failure(StatusCode::NOT_FOUND, e))?;
    let len = file
        .metadata()
        .await
        .map_err(|e| failure(StatusCode::NOT_FOUND, e))?
        .len();
    let filename = name.get(37..).unwrap_or(&name);
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".into()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
            (header::CONTENT_LENGTH, len.to_string()),
            (header::CACHE_CONTROL, "no-store".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        axum::body::Body::from_stream(DownloadStream {
            reader: tokio_util::io::ReaderStream::new(file),
            temporary,
        }),
    )
        .into_response())
}
async fn delete_file(
    State(s): State<Shared>,
    RoutePath((id, name)): RoutePath<(String, String)>,
) -> Result<Json<Value>> {
    let _lease = enter(&s)?;
    client(&s, &id)?;
    let path = file_path(&s, &name)?;
    if s.clients.lock().unwrap().values().any(|c| c.app.busy()) {
        return Err(failure(
            StatusCode::CONFLICT,
            "Wait for running queries and jobs",
        ));
    }
    let connections = s
        .store
        .list_connections()
        .map_err(|e| failure(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if connections.iter().any(|c| {
        c.config.engine == db_core::Engine::Sqlite && Path::new(&c.config.database) == path
    }) {
        return Err(failure(
            StatusCode::CONFLICT,
            "Delete the SQLite connection before removing its database file",
        ));
    }
    tokio::fs::remove_file(path)
        .await
        .map_err(|e| failure(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(Value::Null))
}
pub async fn run() -> std::result::Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::PermissionsExt;
    let data = PathBuf::from(
        std::env::var("ZANAHORIA_DATA").unwrap_or_else(|_| "/var/lib/zanahoria".into()),
    );
    std::fs::create_dir_all(data.join("files"))?;
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700))?;
    let fresh = !data.join("zanahoria.db").exists();
    let store = app_store::AppStore::open_with_secrets(
        &data,
        Box::new(app_store::FileCipherStore::new(&data)),
    )?;
    if fresh {
        store.set_kv("settings", "language", &json!("es"))?;
    }
    let shared = Arc::new(Server {
        store: Arc::new(store),
        files: data.join("files"),
        clients: Mutex::new(HashMap::new()),
        gate: Mutex::new(Gate {
            maintenance: false,
            active: 0,
        }),
        uploads: Mutex::new(HashSet::new()),
    });
    let shutdown = shared.clone();
    let router = Router::new()
        .route("/health", get(|| async { Json(json!({"ok":true})) }))
        .route("/quiesce", post(quiesce))
        .route("/resume", post(resume))
        .route("/client", post(new_client))
        .route("/client/{id}/rpc/{command}", post(call))
        .route("/client/{id}/events", get(events))
        .route("/client/{id}/files", get(files).post(allocate))
        .route(
            "/client/{id}/files/{name}",
            get(download).put(upload).delete(delete_file),
        )
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .with_state(shared);
    let socket = PathBuf::from(
        std::env::var("ZANAHORIA_SOCKET").unwrap_or_else(|_| "/run/zanahoria/web.sock".into()),
    );
    if socket.exists() {
        std::fs::remove_file(&socket)?
    }
    let listener = tokio::net::UnixListener::bind(&socket)?;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o660))?;
    eprintln!("Zanahoria web ready on Unix socket");
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("signal handler");
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
            for client in shutdown.clients.lock().unwrap().values() {
                client.app.cancel();
            }
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{Emitter, Manager};
    fn server(root: &Path) -> Shared {
        std::fs::create_dir_all(root.join("files")).unwrap();
        let store = app_store::AppStore::open_with_secrets(
            root,
            Box::new(app_store::FileCipherStore::new(root)),
        )
        .unwrap();
        Arc::new(Server {
            store: Arc::new(store),
            files: root.join("files"),
            clients: Mutex::new(HashMap::new()),
            gate: Mutex::new(Gate {
                maintenance: false,
                active: 0,
            }),
            uploads: Mutex::new(HashSet::new()),
        })
    }
    #[tokio::test]
    async fn uploaded_and_exported_files_cannot_be_replaced_or_deleted_on_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let s = server(dir.path());
        let id = new_client(State(s.clone())).await.unwrap().0["id"]
            .as_str()
            .unwrap()
            .to_string();
        let file = allocate(
            State(s.clone()),
            RoutePath(id.clone()),
            Json(FileRequest {
                name: "export.csv".into(),
            }),
        )
        .await
        .unwrap()
        .0;
        let name = file["name"].as_str().unwrap().to_string();
        let path = PathBuf::from(file["path"].as_str().unwrap());
        std::fs::write(&path, b"finished export").unwrap();
        let req = Request::builder()
            .body(axum::body::Body::from("replacement"))
            .unwrap();
        assert_eq!(
            upload(State(s.clone()), RoutePath((id.clone(), name)), req)
                .await
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"finished export");
        let file = allocate(
            State(s.clone()),
            RoutePath(id.clone()),
            Json(FileRequest {
                name: "upload.txt".into(),
            }),
        )
        .await
        .unwrap()
        .0;
        let name = file["name"].as_str().unwrap().to_string();
        let path = PathBuf::from(file["path"].as_str().unwrap());
        let _ = upload(
            State(s.clone()),
            RoutePath((id.clone(), name.clone())),
            Request::builder()
                .body(axum::body::Body::from("original"))
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            upload(
                State(s.clone()),
                RoutePath((id, name)),
                Request::builder()
                    .body(axum::body::Body::from("replacement"))
                    .unwrap()
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(std::fs::read(path).unwrap(), b"original");
    }
    #[tokio::test]
    async fn clients_isolate_events_and_backup_gate_preserves_active_work() {
        let dir = tempfile::tempdir().unwrap();
        let s = server(dir.path());
        let a = new_client(State(s.clone())).await.unwrap().0["id"]
            .as_str()
            .unwrap()
            .to_string();
        let b = new_client(State(s.clone())).await.unwrap().0["id"]
            .as_str()
            .unwrap()
            .to_string();
        let c = client(&s, &a).unwrap();
        c.app.emit("query:event", json!({"queryId":"one"})).unwrap();
        assert_eq!(c.app.events_after(0).0.len(), 1);
        assert!(client(&s, &b).unwrap().app.events_after(0).0.is_empty());
        assert!(client(&s, "unknown").is_err());
        let lease = enter(&s).unwrap();
        assert_eq!(
            quiesce(State(s.clone())).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        drop(lease);
        let state = c.app.state::<state::AppState>();
        state.queries.lock().unwrap().insert(
            "busy".into(),
            state::RunningQuery {
                cancel: tokio_util::sync::CancellationToken::new(),
                resume: Arc::new(tokio::sync::Notify::new()),
            },
        );
        assert_eq!(
            quiesce(State(s.clone())).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        state.queries.lock().unwrap().clear();
        let _ = quiesce(State(s.clone())).await.unwrap();
        assert!(enter(&s).is_err());
        let _ = resume(State(s.clone())).await;
        assert!(enter(&s).is_ok());
    }
    async fn query(app: &AppHandle, conn: &str, sql: &str) -> Value {
        let id = uuid::Uuid::new_v4().to_string();
        let result = rpc::dispatch(
            app,
            "run_query",
            json!({"queryId":id,"connId":conn,"database":"","sql":sql,"confirmDangerous":true}),
        )
        .await
        .unwrap();
        for _ in 0..200 {
            if app
                .events_after(0)
                .0
                .iter()
                .any(|e| e.payload["queryId"] == id && e.payload["event"]["kind"] == "done")
            {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("query did not finish")
    }
    #[tokio::test]
    async fn sqlite_commands_mutations_exports_and_private_paths() {
        let dir = tempfile::tempdir().unwrap();
        let s = server(dir.path());
        let app = AppHandle::new(s.store.clone(), s.files.clone());
        let conn = uuid::Uuid::new_v4().to_string();
        let db = s
            .files
            .join(format!("{}-data.sqlite", uuid::Uuid::new_v4()));
        std::fs::write(&db, []).unwrap();
        let config =
            json!({"id":conn,"name":"fixture","engine":"sqlite","database":db,"safeMode":true});
        rpc::dispatch(&app, "save_connection", json!({"config":config}))
            .await
            .unwrap();
        rpc::dispatch(&app, "connect", json!({"connId":conn}))
            .await
            .unwrap();
        query(
            &app,
            &conn,
            "CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT)",
        )
        .await;
        query(&app, &conn, "INSERT INTO people VALUES(1,'Before')").await;
        rpc::dispatch(&app, "get_schema", json!({"connId":conn,"database":""}))
            .await
            .unwrap();
        let result = query(&app, &conn, "SELECT * FROM people").await;
        assert!(result["editability"]["editable"].as_bool().unwrap());
        // DbValue's serialized representation is supplied below by its real serde implementation.
        let change = db_core::PendingChange {
            kind: db_core::ChangeKind::Update,
            target: 0,
            pk: HashMap::from([("id".into(), db_core::DbValue::Int(1))]),
            values: HashMap::from([("name".into(), db_core::DbValue::Text("After".into()))]),
            old_values: HashMap::from([("name".into(), db_core::DbValue::Text("Before".into()))]),
        };
        let args = json!({"connId":conn,"database":"","editability":result["editability"],"changes":[change]});
        let preview = rpc::dispatch(&app, "preview_mutations", args.clone())
            .await
            .unwrap();
        assert!(!preview["statements"].as_array().unwrap().is_empty());
        let mutated = rpc::dispatch(&app, "apply_mutations", args).await.unwrap();
        assert_eq!(mutated["affectedTotal"], 1);
        for format in ["csv", "json", "sql", "xlsx"] {
            let path = s
                .files
                .join(format!("{}-result.{format}", uuid::Uuid::new_v4()));
            let result=rpc::dispatch(&app,"export_query",json!({"exportId":uuid::Uuid::new_v4(),"connId":conn,"database":"","sql":"SELECT * FROM people","format":format,"path":path})).await.unwrap();
            assert_eq!(result["rows"], 1);
            assert!(std::fs::metadata(path).unwrap().len() > 0);
        }
        let path = s
            .files
            .join(format!("{}-backup.sqlite", uuid::Uuid::new_v4()));
        rpc::dispatch(&app, "sqlite_backup", json!({"connId":conn,"dest":path}))
            .await
            .unwrap();
        assert!(std::fs::metadata(path).unwrap().len() > 0);
        assert!(
            rpc::dispatch(&app, "read_text_file", json!({"path":"/etc/passwd"}))
                .await
                .is_err()
        );
        assert!(rpc::dispatch(&app,"save_connection",json!({"config":{"id":uuid::Uuid::new_v4(),"name":"bad","engine":"sqlite","database":"/etc/quimera/quimera.sqlite","safeMode":true}})).await.is_err());
        assert!(rpc::dispatch(
            &app,
            "kv_set",
            json!({"table":"settings","key":"backup_tool_paths","value":{"pg_dump":"/bin/sh"}})
        )
        .await
        .is_err());
    }
}
