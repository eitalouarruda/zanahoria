pub mod mysql;
mod pg_diag;
pub mod postgres;
pub mod redis;
pub mod sqlite;

use crate::config::{ConnectionConfig, Engine};
use crate::driver::{Capabilities, ExecOpts, MutationResult, MutationStatement, QueryStream};
use crate::error::{DbError, Result};
use crate::schema::DbSchema;

pub use mysql::{MySqlEngine, MySqlFlavor};
pub use postgres::PgEngine;
pub use redis::RedisEngine;
pub use sqlite::SqliteEngine;

/// Handle concreto de una conexión abierta. Dispatch por enum (los tipos de
/// pool de sqlx difieren por engine, un trait object no aplica limpio aquí).
pub enum EngineHandle {
    Postgres(PgEngine),
    MySql(MySqlEngine),
    Sqlite(SqliteEngine),
    Redis(RedisEngine),
}

impl EngineHandle {
    pub async fn connect(cfg: &ConnectionConfig, max_conns: u32) -> Result<Self> {
        Ok(match cfg.engine {
            Engine::Postgres => EngineHandle::Postgres(PgEngine::connect(cfg, max_conns).await?),
            Engine::Mysql | Engine::Mariadb => {
                EngineHandle::MySql(MySqlEngine::connect(cfg, max_conns).await?)
            }
            Engine::Sqlite => EngineHandle::Sqlite(SqliteEngine::connect(cfg, max_conns).await?),
            Engine::Redis => EngineHandle::Redis(RedisEngine::connect(cfg).await?),
        })
    }

    pub fn capabilities(&self) -> Capabilities {
        match self {
            EngineHandle::Postgres(_) => Capabilities {
                sql: true,
                transactions: true,
                multiple_databases: true,
                backup: true,
            },
            EngineHandle::MySql(_) => Capabilities {
                sql: true,
                transactions: true,
                multiple_databases: true,
                backup: true,
            },
            EngineHandle::Sqlite(_) => Capabilities {
                sql: true,
                transactions: true,
                multiple_databases: false,
                backup: true,
            },
            EngineHandle::Redis(_) => Capabilities {
                sql: false,
                transactions: false,
                multiple_databases: true,
                backup: false,
            },
        }
    }

    pub async fn ping(&self) -> Result<()> {
        match self {
            EngineHandle::Postgres(e) => e.ping().await,
            EngineHandle::MySql(e) => e.ping().await,
            EngineHandle::Sqlite(e) => e.ping().await,
            EngineHandle::Redis(e) => e.ping().await,
        }
    }

    pub async fn disconnect(&self) {
        match self {
            EngineHandle::Postgres(e) => e.disconnect().await,
            EngineHandle::MySql(e) => e.disconnect().await,
            EngineHandle::Sqlite(e) => e.disconnect().await,
            EngineHandle::Redis(e) => e.disconnect().await,
        }
    }

    pub fn execute(&self, sql: String, opts: ExecOpts) -> QueryStream {
        match self {
            EngineHandle::Postgres(e) => e.execute(sql, opts),
            EngineHandle::MySql(e) => e.execute(sql, opts),
            EngineHandle::Sqlite(e) => e.execute(sql, opts),
            EngineHandle::Redis(e) => e.execute(sql, opts),
        }
    }

    pub async fn list_databases(&self) -> Result<Vec<String>> {
        match self {
            EngineHandle::Postgres(e) => e.list_databases().await,
            EngineHandle::MySql(e) => e.list_databases().await,
            EngineHandle::Sqlite(e) => e.list_databases().await,
            EngineHandle::Redis(e) => e.list_databases().await,
        }
    }

    /// Versión del servidor ("18.6 (Debian…)", "8.0.36", "10.11.6-MariaDB").
    pub async fn server_version(&self) -> Result<String> {
        match self {
            EngineHandle::Postgres(e) => e.server_version().await,
            EngineHandle::MySql(e) => e.server_version().await,
            _ => Err(DbError::Unsupported("server version".into())),
        }
    }

    /// Crea una database nueva en el servidor.
    pub async fn create_database(&self, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(DbError::Other("database name is empty".into()));
        }
        match self {
            EngineHandle::Postgres(e) => e.create_database(name).await,
            EngineHandle::MySql(e) => e.create_database(name).await,
            _ => Err(DbError::Unsupported(
                "this engine cannot create databases".into(),
            )),
        }
    }

    /// Tablas de usuario en la database del handle.
    pub async fn user_table_count(&self) -> Result<i64> {
        match self {
            EngineHandle::Postgres(e) => e.user_table_count().await,
            EngineHandle::MySql(e) => e.user_table_count().await,
            _ => Err(DbError::Unsupported("table count".into())),
        }
    }

    pub async fn introspect(&self, database: &str) -> Result<DbSchema> {
        match self {
            EngineHandle::Postgres(e) => e.introspect().await,
            EngineHandle::MySql(e) => e.introspect(database).await,
            EngineHandle::Sqlite(e) => e.introspect().await,
            EngineHandle::Redis(e) => e.introspect().await,
        }
    }

    /// Respaldo de SQLite sin binarios externos (copia consistente).
    pub async fn sqlite_vacuum_into(&self, dest: &str) -> Result<()> {
        match self {
            EngineHandle::Sqlite(e) => e.vacuum_into(dest).await,
            _ => Err(DbError::Unsupported("vacuum into is sqlite-only".into())),
        }
    }

    pub async fn apply_mutations(
        &self,
        statements: Vec<MutationStatement>,
        in_tx: bool,
    ) -> Result<MutationResult> {
        match self {
            EngineHandle::Postgres(e) => e.apply_mutations(statements, in_tx).await,
            EngineHandle::MySql(e) => e.apply_mutations(statements, in_tx).await,
            EngineHandle::Sqlite(e) => e.apply_mutations(statements, in_tx).await,
            EngineHandle::Redis(_) => Err(DbError::Unsupported(
                "redis does not support SQL mutations".into(),
            )),
        }
    }
}
