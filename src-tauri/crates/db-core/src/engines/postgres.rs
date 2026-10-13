use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode};
use sqlx::{Column as _, Row as _, TypeInfo as _};

use crate::config::ConnectionConfig;
use crate::driver::{ExecOpts, MutationResult, MutationStatement, QueryStream};
use crate::error::{DbError, Result};
use crate::exec::spawn_stream;
use crate::schema::{Column, DbSchema, Namespace, Table, TableKind};
use crate::value::{DbValue, Row};

pub struct PgEngine {
    pool: PgPool,
}

impl PgEngine {
    pub async fn connect(cfg: &ConnectionConfig, max_conns: u32) -> Result<Self> {
        let mut opts = PgConnectOptions::new()
            .host(&cfg.host)
            .port(cfg.port.unwrap_or(5432))
            .username(&cfg.user)
            .ssl_mode(if cfg.use_tls {
                PgSslMode::Require
            } else {
                PgSslMode::Prefer
            });
        if !cfg.database.is_empty() {
            opts = opts.database(&cfg.database);
        }
        if let Some(pw) = &cfg.password {
            opts = opts.password(pw);
        }
        let pool = PgPoolOptions::new()
            .max_connections(max_conns)
            .acquire_timeout(std::time::Duration::from_secs(15))
            .connect_with(opts)
            .await;
        let pool = match pool {
            Ok(pool) => pool,
            Err(e) => {
                let msg = e.to_string();
                // El servidor mandó el error en un encoding no UTF-8: recuperarlo.
                if msg.contains(super::pg_diag::NON_UTF8_ERROR) {
                    if let Some(real) = super::pg_diag::raw_auth_error(cfg).await {
                        return Err(DbError::Connection(format!(
                            "{real} (mensaje del servidor en encoding no UTF-8, decodificado como Latin-1)"
                        )));
                    }
                }
                return Err(DbError::Connection(msg));
            }
        };
        Ok(Self { pool })
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
        let rows =
            sqlx::query("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.iter().map(|r| r.get::<String, _>(0)).collect())
    }

    pub async fn introspect(&self) -> Result<DbSchema> {
        let cols = sqlx::query(
            r#"
            SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
                   c.is_nullable = 'YES' AS nullable, t.table_type
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY c.table_schema, c.table_name, c.ordinal_position
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        let pks = sqlx::query(
            r#"
            SELECT tc.table_schema, tc.table_name, kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name
             AND kcu.table_schema = tc.table_schema
             AND kcu.table_name = tc.table_name
            WHERE tc.constraint_type = 'PRIMARY KEY'
            ORDER BY kcu.ordinal_position
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        let pk_lookup: Vec<(String, String, String)> =
            pks.iter().map(|r| (r.get(0), r.get(1), r.get(2))).collect();

        let mut namespaces: Vec<Namespace> = Vec::new();
        for row in &cols {
            let schema: String = row.get(0);
            let table: String = row.get(1);
            let column: String = row.get(2);
            let db_type: String = row.get(3);
            let nullable: bool = row.get(4);
            let table_type: String = row.get(5);

            let is_pk = pk_lookup
                .iter()
                .any(|(s, t, c)| *s == schema && *t == table && *c == column);

            let ns = match namespaces.iter_mut().find(|n| n.name == schema) {
                Some(ns) => ns,
                None => {
                    namespaces.push(Namespace {
                        name: schema.clone(),
                        tables: Vec::new(),
                    });
                    namespaces.last_mut().unwrap()
                }
            };
            let tbl = match ns.tables.iter_mut().find(|t| t.name == table) {
                Some(t) => t,
                None => {
                    ns.tables.push(Table {
                        name: table.clone(),
                        kind: if table_type == "VIEW" {
                            TableKind::View
                        } else {
                            TableKind::Table
                        },
                        columns: Vec::new(),
                        primary_key: pk_lookup
                            .iter()
                            .filter(|(s, t, _)| *s == schema && *t == table)
                            .map(|(_, _, c)| c.clone())
                            .collect(),
                    });
                    ns.tables.last_mut().unwrap()
                }
            };
            tbl.columns.push(Column {
                name: column,
                db_type,
                nullable,
                is_pk,
            });
        }
        Ok(DbSchema { namespaces })
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

type PgQuery<'q> = sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>;

/// Los valores no nativos (decimal, fechas, uuid…) se bindean como texto;
/// mutation.rs genera casts explícitos (`$1::numeric`) en el SQL.
fn bind_value<'q>(q: PgQuery<'q>, v: &'q DbValue) -> Result<PgQuery<'q>> {
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

fn decode_row(row: &PgRow) -> Row {
    row.columns()
        .iter()
        .enumerate()
        .map(|(i, col)| decode_cell(row, i, col.type_info().name()))
        .collect()
}

fn decode_cell(row: &PgRow, i: usize, type_name: &str) -> DbValue {
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
        "BOOL" => get!(bool, DbValue::Bool),
        "INT2" => get!(i16, |v: i16| DbValue::Int(v as i64)),
        "INT4" => get!(i32, |v: i32| DbValue::Int(v as i64)),
        "INT8" | "OID" => get!(i64, DbValue::Int),
        "FLOAT4" => get!(f32, |v: f32| DbValue::Float(v as f64)),
        "FLOAT8" => get!(f64, DbValue::Float),
        "NUMERIC" => get!(rust_decimal::Decimal, |v: rust_decimal::Decimal| {
            DbValue::Decimal(v.to_string())
        }),
        "UUID" => get!(uuid::Uuid, |v: uuid::Uuid| DbValue::Uuid(v.to_string())),
        "JSON" | "JSONB" => get!(serde_json::Value, DbValue::Json),
        "DATE" => get!(chrono::NaiveDate, |v: chrono::NaiveDate| DbValue::Date(
            v.to_string()
        )),
        "TIME" => get!(chrono::NaiveTime, |v: chrono::NaiveTime| DbValue::Time(
            v.to_string()
        )),
        "TIMESTAMP" => get!(chrono::NaiveDateTime, |v: chrono::NaiveDateTime| {
            DbValue::Timestamp(v.and_utc().to_rfc3339())
        }),
        "TIMESTAMPTZ" => get!(chrono::DateTime<chrono::Utc>, |v: chrono::DateTime<
            chrono::Utc,
        >| DbValue::Timestamp(
            v.to_rfc3339()
        )),
        "BYTEA" => get!(Vec<u8>, |v: Vec<u8>| DbValue::Bytes(
            base64::engine::general_purpose::STANDARD.encode(v)
        )),
        _ => {}
    }
    // Fallback: intentar como texto (VARCHAR, TEXT, enums, tipos raros).
    match row.try_get::<Option<String>, _>(i) {
        Ok(Some(s)) => DbValue::Text(s),
        Ok(None) => DbValue::Null,
        Err(_) => DbValue::Text(format!("<{type_name}>")),
    }
}
