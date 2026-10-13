use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::{Column as _, Row as _, TypeInfo as _};

use crate::config::ConnectionConfig;
use crate::driver::{ExecOpts, MutationResult, MutationStatement, QueryStream};
use crate::error::{DbError, Result};
use crate::exec::spawn_stream;
use crate::schema::{Column, DbSchema, Namespace, Table, TableKind};
use crate::value::{DbValue, Row};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MySqlFlavor {
    MySql,
    MariaDb,
}

pub struct MySqlEngine {
    pool: MySqlPool,
    pub flavor: MySqlFlavor,
}

impl MySqlEngine {
    pub async fn connect(cfg: &ConnectionConfig, max_conns: u32) -> Result<Self> {
        let mut opts = MySqlConnectOptions::new()
            .host(&cfg.host)
            .port(cfg.port.unwrap_or(3306))
            .username(&cfg.user)
            .ssl_mode(if cfg.use_tls {
                MySqlSslMode::Required
            } else {
                MySqlSslMode::Preferred
            });
        if !cfg.database.is_empty() {
            opts = opts.database(&cfg.database);
        }
        if let Some(pw) = &cfg.password {
            opts = opts.password(pw);
        }
        let pool = MySqlPoolOptions::new()
            .max_connections(max_conns)
            .acquire_timeout(std::time::Duration::from_secs(15))
            .connect_with(opts)
            .await
            .map_err(|e| DbError::Connection(e.to_string()))?;

        let version: String = sqlx::query_scalar("SELECT VERSION()")
            .fetch_one(&pool)
            .await?;
        let flavor = if version.to_lowercase().contains("mariadb") {
            MySqlFlavor::MariaDb
        } else {
            MySqlFlavor::MySql
        };
        Ok(Self { pool, flavor })
    }

    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn disconnect(&self) {
        self.pool.close().await;
    }

    pub fn execute(&self, sql: String, opts: ExecOpts) -> QueryStream {
        spawn_stream!(&self.pool, sql, opts, decode_row)
    }

    pub async fn list_databases(&self) -> Result<Vec<String>> {
        let rows = sqlx::query("SHOW DATABASES").fetch_all(&self.pool).await?;
        Ok(rows.iter().map(|r| r.get::<String, _>(0)).collect())
    }

    pub async fn introspect(&self, database: &str) -> Result<DbSchema> {
        let cols = sqlx::query(
            r#"
            SELECT CAST(c.TABLE_NAME AS CHAR), CAST(c.COLUMN_NAME AS CHAR),
                   CAST(c.DATA_TYPE AS CHAR),
                   c.IS_NULLABLE = 'YES', c.COLUMN_KEY = 'PRI',
                   CAST(t.TABLE_TYPE AS CHAR)
            FROM information_schema.COLUMNS c
            JOIN information_schema.TABLES t
              ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
            WHERE c.TABLE_SCHEMA = ?
            ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
            "#,
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await?;

        let mut tables: Vec<Table> = Vec::new();
        for row in &cols {
            let table: String = row.get(0);
            let column: String = row.get(1);
            let db_type: String = row.get(2);
            let nullable: bool = row.get::<i64, _>(3) != 0;
            let is_pk: bool = row.get::<i64, _>(4) != 0;
            let table_type: String = row.get(5);

            let tbl = match tables.iter_mut().find(|t| t.name == table) {
                Some(t) => t,
                None => {
                    tables.push(Table {
                        name: table.clone(),
                        kind: if table_type.contains("VIEW") {
                            TableKind::View
                        } else {
                            TableKind::Table
                        },
                        columns: Vec::new(),
                        primary_key: Vec::new(),
                    });
                    tables.last_mut().unwrap()
                }
            };
            if is_pk {
                tbl.primary_key.push(column.clone());
            }
            tbl.columns.push(Column {
                name: column,
                db_type,
                nullable,
                is_pk,
            });
        }
        Ok(DbSchema {
            namespaces: vec![Namespace {
                name: database.to_string(),
                tables,
            }],
        })
    }

    pub async fn apply_mutations(
        &self,
        statements: Vec<MutationStatement>,
        in_tx: bool,
    ) -> Result<MutationResult> {
        let mut affected_total = 0u64;
        if in_tx {
            let mut tx = self.pool.begin().await?;
            for st in &statements {
                let mut q = sqlx::query(&st.sql);
                for p in &st.params {
                    q = bind_value(q, p)?;
                }
                let res = q.execute(&mut *tx).await?;
                let n = res.rows_affected();
                if let Some(expected) = st.expected_rows {
                    if n != expected {
                        tx.rollback().await?;
                        return Err(DbError::Query(format!(
                            "affected {n} rows, expected {expected} — rolled back: {}",
                            st.preview_sql
                        )));
                    }
                }
                affected_total += n;
            }
            tx.commit().await?;
        } else {
            for st in &statements {
                let mut q = sqlx::query(&st.sql);
                for p in &st.params {
                    q = bind_value(q, p)?;
                }
                affected_total += q.execute(&self.pool).await?.rows_affected();
            }
        }
        Ok(MutationResult {
            affected_total,
            statements_run: statements.len(),
        })
    }
}

type MyQuery<'q> = sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>;

fn bind_value<'q>(q: MyQuery<'q>, v: &'q DbValue) -> Result<MyQuery<'q>> {
    Ok(match v {
        DbValue::Null => q.bind(Option::<String>::None),
        DbValue::Bool(b) => q.bind(*b),
        DbValue::Int(i) => q.bind(*i),
        DbValue::Float(f) => q.bind(*f),
        DbValue::Decimal(s)
        | DbValue::Text(s)
        | DbValue::Date(s)
        | DbValue::Time(s)
        | DbValue::Timestamp(s)
        | DbValue::Uuid(s) => q.bind(s.as_str()),
        DbValue::Json(j) => q.bind(j.clone()),
        DbValue::Bytes(b64) => {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| DbError::Other(format!("invalid base64: {e}")))?;
            q.bind(bytes)
        }
    })
}

fn decode_row(row: &MySqlRow) -> Row {
    row.columns()
        .iter()
        .enumerate()
        .map(|(i, col)| decode_cell(row, i, col.type_info().name()))
        .collect()
}

fn decode_cell(row: &MySqlRow, i: usize, type_name: &str) -> DbValue {
    use base64::Engine as _;

    macro_rules! get {
        ($ty:ty, $map:expr) => {
            match row.try_get::<Option<$ty>, _>(i) {
                Ok(Some(v)) => return $map(v),
                Ok(None) => return DbValue::Null,
                Err(_) => {}
            }
        };
    }

    match type_name {
        "BOOLEAN" => get!(bool, DbValue::Bool),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => get!(i64, DbValue::Int),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" => get!(u64, |v: u64| DbValue::Int(v as i64)),
        "FLOAT" => get!(f32, |v: f32| DbValue::Float(v as f64)),
        "DOUBLE" => get!(f64, DbValue::Float),
        "DECIMAL" => get!(rust_decimal::Decimal, |v: rust_decimal::Decimal| {
            DbValue::Decimal(v.to_string())
        }),
        "JSON" => get!(serde_json::Value, DbValue::Json),
        "DATE" => get!(chrono::NaiveDate, |v: chrono::NaiveDate| DbValue::Date(
            v.to_string()
        )),
        "TIME" => get!(chrono::NaiveTime, |v: chrono::NaiveTime| DbValue::Time(
            v.to_string()
        )),
        "DATETIME" => get!(chrono::NaiveDateTime, |v: chrono::NaiveDateTime| {
            DbValue::Timestamp(v.and_utc().to_rfc3339())
        }),
        "TIMESTAMP" => get!(chrono::DateTime<chrono::Utc>, |v: chrono::DateTime<
            chrono::Utc,
        >| DbValue::Timestamp(
            v.to_rfc3339()
        )),
        "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "VARBINARY" | "BINARY" => {
            get!(Vec<u8>, |v: Vec<u8>| DbValue::Bytes(
                base64::engine::general_purpose::STANDARD.encode(v)
            ))
        }
        _ => {}
    }
    match row.try_get::<Option<String>, _>(i) {
        Ok(Some(s)) => DbValue::Text(s),
        Ok(None) => DbValue::Null,
        Err(_) => DbValue::Text(format!("<{type_name}>")),
    }
}
