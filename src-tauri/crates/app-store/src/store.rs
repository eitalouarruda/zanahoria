use std::path::Path;
use std::sync::Mutex;

use db_core::ConnectionConfig;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::secrets::{default_secret_store, SecretStore};
use crate::{Result, StoreError};

const HISTORY_CAP_PER_CONNECTION: usize = 1000;

const MIGRATIONS: &[&str] = &[
    // v1
    "CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE query_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conn_id TEXT NOT NULL,
        database TEXT NOT NULL DEFAULT '',
        sql TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        executed_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_history_conn ON query_history (conn_id, executed_at DESC);
    CREATE TABLE favorites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sql TEXT NOT NULL,
        conn_id TEXT NOT NULL,
        database TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    CREATE TABLE ui_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    #[serde(flatten)]
    pub config: ConnectionConfig,
    pub has_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub conn_id: String,
    pub database: String,
    pub sql: String,
    pub status: String,
    pub duration_ms: i64,
    pub executed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteQuery {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub conn_id: String,
    pub database: String,
    pub tags: Vec<String>,
    pub created_at: i64,
}

pub struct AppStore {
    conn: Mutex<Connection>,
    secrets: Box<dyn SecretStore>,
}

impl AppStore {
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).map_err(|e| StoreError::Other(e.to_string()))?;
        let conn = Connection::open(data_dir.join("zanahoria.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            secrets: default_secret_store(data_dir),
        })
    }

    #[cfg(test)]
    pub fn open_with_secrets(data_dir: &Path, secrets: Box<dyn SecretStore>) -> Result<Self> {
        let conn = Connection::open(data_dir.join("zanahoria.db"))?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            secrets,
        })
    }

    fn migrate(conn: &Connection) -> Result<()> {
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, migration) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(migration)?;
            conn.pragma_update(None, "user_version", i as i64 + 1)?;
        }
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("app-store mutex poisoned")
    }

    // ---- Conexiones -------------------------------------------------------

    /// Guarda (upsert) la conexión. El password se separa hacia el
    /// SecretStore y nunca toca el SQLite.
    pub fn save_connection(&self, mut config: ConnectionConfig) -> Result<()> {
        if let Some(password) = config.password.take() {
            self.secrets.set(&config.id, &password)?;
        }
        let json = serde_json::to_string(&config).map_err(|e| StoreError::Other(e.to_string()))?;
        self.lock().execute(
            "INSERT INTO connections (id, config_json) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json",
            params![config.id, json],
        )?;
        Ok(())
    }

    pub fn list_connections(&self) -> Result<Vec<SavedConnection>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT config_json FROM connections ORDER BY created_at")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            let config: ConnectionConfig =
                serde_json::from_str(&row?).map_err(|e| StoreError::Other(e.to_string()))?;
            let has_password = self.secrets.get(&config.id).ok().flatten().is_some();
            out.push(SavedConnection {
                config,
                has_password,
            });
        }
        Ok(out)
    }

    /// Config con password resuelto desde el SecretStore, lista para conectar.
    pub fn connection_for_connect(&self, conn_id: &str) -> Result<ConnectionConfig> {
        let json: Option<String> = self
            .lock()
            .query_row(
                "SELECT config_json FROM connections WHERE id = ?1",
                params![conn_id],
                |r| r.get(0),
            )
            .optional()?;
        let mut config: ConnectionConfig = serde_json::from_str(
            &json.ok_or_else(|| StoreError::Other(format!("connection {conn_id} not found")))?,
        )
        .map_err(|e| StoreError::Other(e.to_string()))?;
        config.password = self.secrets.get(conn_id)?;
        Ok(config)
    }

    /// Password guardada de una conexión (None si no existe o no tiene).
    pub fn saved_password(&self, conn_id: &str) -> Result<Option<String>> {
        self.secrets.get(conn_id)
    }

    pub fn delete_connection(&self, conn_id: &str) -> Result<()> {
        self.lock()
            .execute("DELETE FROM connections WHERE id = ?1", params![conn_id])?;
        self.secrets.delete(conn_id)?;
        Ok(())
    }

    // ---- Query history ----------------------------------------------------

    pub fn add_history(
        &self,
        conn_id: &str,
        database: &str,
        sql: &str,
        status: &str,
        duration_ms: i64,
    ) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO query_history (conn_id, database, sql, status, duration_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![conn_id, database, sql, status, duration_ms],
        )?;
        conn.execute(
            "DELETE FROM query_history WHERE conn_id = ?1 AND id NOT IN (
                SELECT id FROM query_history WHERE conn_id = ?1
                ORDER BY executed_at DESC, id DESC LIMIT ?2
             )",
            params![conn_id, HISTORY_CAP_PER_CONNECTION],
        )?;
        Ok(())
    }

    pub fn get_history(
        &self,
        conn_id: Option<&str>,
        search: Option<&str>,
        limit: usize,
    ) -> Result<Vec<HistoryEntry>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conn_id, database, sql, status, duration_ms, executed_at
             FROM query_history
             WHERE (?1 IS NULL OR conn_id = ?1)
               AND (?2 IS NULL OR sql LIKE '%' || ?2 || '%')
             ORDER BY executed_at DESC, id DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![conn_id, search, limit], |r| {
            Ok(HistoryEntry {
                id: r.get(0)?,
                conn_id: r.get(1)?,
                database: r.get(2)?,
                sql: r.get(3)?,
                status: r.get(4)?,
                duration_ms: r.get(5)?,
                executed_at: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn clear_history(&self, conn_id: Option<&str>) -> Result<()> {
        self.lock().execute(
            "DELETE FROM query_history WHERE (?1 IS NULL OR conn_id = ?1)",
            params![conn_id],
        )?;
        Ok(())
    }

    // ---- Favorites --------------------------------------------------------

    pub fn save_favorite(&self, mut fav: FavoriteQuery) -> Result<FavoriteQuery> {
        if fav.id.is_empty() {
            fav.id = uuid::Uuid::new_v4().to_string();
        }
        let tags =
            serde_json::to_string(&fav.tags).map_err(|e| StoreError::Other(e.to_string()))?;
        self.lock().execute(
            "INSERT INTO favorites (id, name, sql, conn_id, database, tags_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, sql = excluded.sql, conn_id = excluded.conn_id,
               database = excluded.database, tags_json = excluded.tags_json",
            params![fav.id, fav.name, fav.sql, fav.conn_id, fav.database, tags],
        )?;
        Ok(fav)
    }

    /// Todas las favoritas de todos los bancos (la vista global filtra en UI).
    pub fn list_favorites(&self) -> Result<Vec<FavoriteQuery>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, sql, conn_id, database, tags_json, created_at
             FROM favorites ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, sql, conn_id, database, tags_json, created_at) = row?;
            out.push(FavoriteQuery {
                id,
                name,
                sql,
                conn_id,
                database,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                created_at,
            });
        }
        Ok(out)
    }

    pub fn delete_favorite(&self, id: &str) -> Result<()> {
        self.lock()
            .execute("DELETE FROM favorites WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---- Settings / UI state ---------------------------------------------

    pub fn get_kv(&self, table: &str, key: &str) -> Result<Option<serde_json::Value>> {
        let sql = match table {
            "settings" => "SELECT value_json FROM settings WHERE key = ?1",
            "ui_state" => "SELECT value_json FROM ui_state WHERE key = ?1",
            _ => return Err(StoreError::Other("invalid kv table".into())),
        };
        let raw: Option<String> = self
            .lock()
            .query_row(sql, params![key], |r| r.get(0))
            .optional()?;
        Ok(match raw {
            Some(s) => {
                Some(serde_json::from_str(&s).map_err(|e| StoreError::Other(e.to_string()))?)
            }
            None => None,
        })
    }

    pub fn set_kv(&self, table: &str, key: &str, value: &serde_json::Value) -> Result<()> {
        let sql = match table {
            "settings" => {
                "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
            }
            "ui_state" => {
                "INSERT INTO ui_state (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
            }
            _ => return Err(StoreError::Other("invalid kv table".into())),
        };
        self.lock().execute(sql, params![key, value.to_string()])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::FileCipherStore;
    use db_core::Engine;

    fn store() -> (tempfile::TempDir, AppStore) {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Box::new(FileCipherStore::new(dir.path()));
        let store = AppStore::open_with_secrets(dir.path(), secrets).unwrap();
        (dir, store)
    }

    fn config(id: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: "test".into(),
            engine: Engine::Postgres,
            host: "localhost".into(),
            port: Some(5432),
            database: "db".into(),
            user: "u".into(),
            password: Some("pw".into()),
            use_tls: false,
            safe_mode: true,
            color: None,
            group: None,
        }
    }

    #[test]
    fn connection_roundtrip_password_separated() {
        let (_dir, store) = store();
        store.save_connection(config("c1")).unwrap();

        let listed = store.list_connections().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].has_password);
        assert!(listed[0].config.password.is_none());
        assert!(listed[0].config.safe_mode);

        let full = store.connection_for_connect("c1").unwrap();
        assert_eq!(full.password.as_deref(), Some("pw"));

        store.delete_connection("c1").unwrap();
        assert!(store.list_connections().unwrap().is_empty());
    }

    #[test]
    fn connection_group_persists() {
        let (_dir, store) = store();
        store.save_connection(config("c1")).unwrap();
        assert_eq!(store.list_connections().unwrap()[0].config.group, None);

        let mut grouped = config("c1");
        grouped.group = Some("Prod".into());
        store.save_connection(grouped).unwrap();
        assert_eq!(
            store.list_connections().unwrap()[0].config.group.as_deref(),
            Some("Prod")
        );
    }

    #[test]
    fn history_prunes_and_filters() {
        let (_dir, store) = store();
        for i in 0..5 {
            store
                .add_history("c1", "db", &format!("SELECT {i}"), "ok", 10)
                .unwrap();
        }
        let all = store.get_history(Some("c1"), None, 100).unwrap();
        assert_eq!(all.len(), 5);
        let filtered = store
            .get_history(Some("c1"), Some("SELECT 3"), 100)
            .unwrap();
        assert_eq!(filtered.len(), 1);
    }

    #[test]
    fn favorites_crud() {
        let (_dir, store) = store();
        let fav = store
            .save_favorite(FavoriteQuery {
                id: String::new(),
                name: "top customers".into(),
                sql: "SELECT * FROM customers".into(),
                conn_id: "c1".into(),
                database: "db".into(),
                tags: vec!["reports".into()],
                created_at: 0,
            })
            .unwrap();
        assert!(!fav.id.is_empty());
        assert_eq!(store.list_favorites().unwrap().len(), 1);
        store.delete_favorite(&fav.id).unwrap();
        assert!(store.list_favorites().unwrap().is_empty());
    }

    #[test]
    fn kv_roundtrip() {
        let (_dir, store) = store();
        store
            .set_kv("settings", "theme", &serde_json::json!("dark"))
            .unwrap();
        assert_eq!(
            store.get_kv("settings", "theme").unwrap(),
            Some(serde_json::json!("dark"))
        );
    }
}
