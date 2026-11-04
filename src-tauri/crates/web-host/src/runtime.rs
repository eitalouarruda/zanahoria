use crate::{
    error::{CmdError, CmdResult},
    state::AppState,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    any::Any,
    collections::VecDeque,
    ops::Deref,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub mod async_runtime {
    pub use tokio::{spawn, task::spawn_blocking};
}
pub struct State<'a, T>(&'a T);
impl<T> Deref for State<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}
pub trait Manager {
    fn state<T: 'static>(&self) -> State<'_, T>;
    fn try_state<T: 'static>(&self) -> Option<State<'_, T>>;
}
pub trait Emitter {
    fn emit<T: Serialize>(&self, event: &str, payload: T) -> CmdResult<()>;
}
#[derive(Clone, Serialize)]
pub struct WebEvent {
    pub seq: u64,
    pub event: String,
    pub payload: Value,
}
struct Journal {
    next: u64,
    bytes: usize,
    events: VecDeque<(WebEvent, usize)>,
}
#[derive(Clone)]
pub struct AppHandle {
    inner: Arc<Inner>,
}
struct Inner {
    state: AppState,
    files: PathBuf,
    journal: Mutex<Journal>,
}
impl AppHandle {
    pub fn new(store: Arc<app_store::AppStore>, files: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: AppState::with_store(store),
                files,
                journal: Mutex::new(Journal {
                    next: 1,
                    bytes: 0,
                    events: VecDeque::new(),
                }),
            }),
        }
    }
    pub fn file_path(&self, path: &str) -> CmdResult<PathBuf> {
        let p = Path::new(path);
        if p.parent() != Some(self.inner.files.as_path())
            || p.file_name()
                .and_then(|s| s.to_str())
                .is_none_or(|s| !valid_file_name(s))
        {
            return Err("Choose a file from Zanahoria's file picker"
                .to_string()
                .into());
        }
        if p.symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err("Symlink files are not allowed".to_string().into());
        }
        Ok(p.to_path_buf())
    }
    pub fn events_after(&self, after: u64) -> (Vec<WebEvent>, bool) {
        let j = self.inner.journal.lock().unwrap();
        let gap = j
            .events
            .front()
            .is_some_and(|(e, _)| after > 0 && after + 1 < e.seq);
        (
            j.events
                .iter()
                .filter(|(e, _)| e.seq > after)
                .map(|(e, _)| e.clone())
                .collect(),
            gap,
        )
    }
    pub fn busy(&self) -> bool {
        !self.inner.state.queries.lock().unwrap().is_empty()
            || !self.inner.state.jobs.lock().unwrap().is_empty()
    }
    pub fn cancel(&self) {
        for q in self.inner.state.queries.lock().unwrap().values() {
            q.cancel.cancel()
        }
        for j in self.inner.state.jobs.lock().unwrap().values() {
            j.cancel()
        }
    }
}
pub fn valid_file_name(s: &str) -> bool {
    s.len() <= 220
        && s.len() > 37
        && s.as_bytes()[36] == b'-'
        && s.get(..36)
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}
impl Manager for AppHandle {
    fn state<T: 'static>(&self) -> State<'_, T> {
        self.try_state().expect("runtime state type")
    }
    fn try_state<T: 'static>(&self) -> Option<State<'_, T>> {
        (&self.inner.state as &dyn Any).downcast_ref().map(State)
    }
}
impl Emitter for AppHandle {
    fn emit<T: Serialize>(&self, event: &str, payload: T) -> CmdResult<()> {
        let payload = serde_json::to_value(payload).map_err(|e| CmdError {
            message: e.to_string(),
        })?;
        let size = serde_json::to_vec(&payload)
            .map_err(|e| e.to_string())?
            .len();
        let mut j = self.inner.journal.lock().unwrap();
        let e = WebEvent {
            seq: j.next,
            event: event.to_string(),
            payload,
        };
        j.next += 1;
        j.bytes += size;
        j.events.push_back((e, size));
        while (j.bytes > 16 * 1024 * 1024 || j.events.len() > 10000) && j.events.len() > 1 {
            if let Some((_, s)) = j.events.pop_front() {
                j.bytes -= s
            }
        }
        Ok(())
    }
}
