use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column as _, Row as _, TypeInfo as _};

use crate::config::ConnectionConfig;
use crate::driver::{ExecOpts, MutationResult, MutationStatement, QueryStream};
use crate::error::{DbError, Result};
use crate::exec::spawn_stream;
use crate::schema::{Column, DbSchema, Namespace, Table, TableKind};
use crate::value::{DbValue, Row};

pub struct SqliteEngine {
    pool: SqlitePool,
    path: String,
}

impl SqliteEngine {
    pub async fn connect(cfg: &ConnectionConfig, max_conns: u32) -> Result<Self> {
        let opts = SqliteConnectOptions::new()
            .filename(&cfg.database)
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(max_conns)
            .acquire_timeout(std::time::Duration::from_secs(15))
            .connect_with(opts)
            .await
            .map_err(|e| DbError::Connection(e.to_string()))?;
        Ok(Self {
            pool,
            path: cfg.database.clone(),
        })
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
        Ok(vec![self.path.clone()])
    }

    /// Copia consistente de la base a `dest` (respaldo sin binarios externos).
    pub async fn vacuum_into(&self, dest: &str) -> Result<()> {
        sqlx::query("VACUUM INTO ?")
            .bind(dest)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn introspect(&self) -> Result<DbSchema> {
        let tables_rows = sqlx::query(
            "SELECT name, type FROM sqlite_master
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut tables: Vec<Table> = Vec::new();
        for trow in &tables_rows {
            let name: String = trow.get(0);
            let kind: String = trow.get(1);
            let cols = sqlx::query(&format!("PRAGMA table_info({})", quote_ident(&name)))
                .fetch_all(&self.pool)
                .await?;
            let mut columns = Vec::new();
            let mut pk_cols: Vec<(i64, String)> = Vec::new();
            for c in &cols {
                let col_name: String = c.get::<String, _>("name");
                let db_type: String = c.get::<String, _>("type");
                let notnull: i64 = c.get::<i64, _>("notnull");
                let pk_order: i64 = c.get::<i64, _>("pk");
                if pk_order > 0 {
                    pk_cols.push((pk_order, col_name.clone()));
                }
                columns.push(Column {
                    name: col_name,
                    db_type,
                    nullable: notnull == 0,
                    is_pk: pk_order > 0,
                });
            }
            pk_cols.sort_by_key(|(order, _)| *order);
            tables.push(Table {
                name,
                kind: if kind == "view" {
                    TableKind::View
                } else {
                    TableKind::Table
                },
                columns,
                primary_key: pk_cols.into_iter().map(|(_, c)| c).collect(),
            });
        }
        Ok(DbSchema {
            namespaces: vec![Namespace {
                name: "main".to_string(),
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

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

type SqQuery<'q> = sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>;

fn bind_value<'q>(q: SqQuery<'q>, v: &'q DbValue) -> Result<SqQuery<'q>> {
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
        DbValue::Json(j) => q.bind(j.to_string()),
        DbValue::Bytes(b64) => {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| DbError::Other(format!("invalid base64: {e}")))?;
            q.bind(bytes)
        }
    })
}

fn decode_row(row: &SqliteRow) -> Row {
    row.columns()
        .iter()
        .enumerate()
        .map(|(i, col)| decode_cell(row, i, col.type_info().name()))
        .collect()
}

fn decode_cell(row: &SqliteRow, i: usize, type_name: &str) -> DbValue {
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
        "INTEGER" => get!(i64, DbValue::Int),
        "REAL" => get!(f64, DbValue::Float),
        "BLOB" => get!(Vec<u8>, |v: Vec<u8>| DbValue::Bytes(
            base64::engine::general_purpose::STANDARD.encode(v)
        )),
        _ => {}
    }
    match row.try_get::<Option<String>, _>(i) {
        Ok(Some(s)) => DbValue::Text(s),
        Ok(None) => DbValue::Null,
        Err(_) => DbValue::Text(format!("<{type_name}>")),
    }
}
