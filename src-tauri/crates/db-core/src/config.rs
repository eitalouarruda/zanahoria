use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Postgres,
    Mysql,
    Mariadb,
    Sqlite,
    Redis,
}

impl Engine {
    pub fn as_str(&self) -> &'static str {
        match self {
            Engine::Postgres => "postgres",
            Engine::Mysql => "mysql",
            Engine::Mariadb => "mariadb",
            Engine::Sqlite => "sqlite",
            Engine::Redis => "redis",
        }
    }

    pub fn default_port(&self) -> Option<u16> {
        match self {
            Engine::Postgres => Some(5432),
            Engine::Mysql | Engine::Mariadb => Some(3306),
            Engine::Sqlite => None,
            Engine::Redis => Some(6379),
        }
    }
}

/// Configuración de conexión. `safe_mode` vive aquí: se persiste con la
/// conexión y aplica siempre hasta que el usuario lo cambie.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    /// Database inicial; para SQLite es la ruta del archivo.
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    /// Solo en runtime; nunca se serializa hacia el storage (va al SecretStore).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default)]
    pub use_tls: bool,
    pub safe_mode: bool,
    #[serde(default)]
    pub color: Option<String>,
    /// Grupo (carpeta) en la lista de conexiones; None = sin grupo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}
