//! Generación de statements UPDATE/DELETE/INSERT a partir de los cambios
//! pendientes del grid. Produce SQL parametrizado (ejecución) + SQL
//! interpolado (Code Preview).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::analyze::Editability;
use crate::config::Engine;
use crate::driver::MutationStatement;
use crate::error::{DbError, Result};
use crate::value::DbValue;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Update,
    Delete,
    Insert,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    pub kind: ChangeKind,
    /// Valores de la PK de la fila afectada (update/delete).
    #[serde(default)]
    pub pk: HashMap<String, DbValue>,
    /// Valores nuevos: columnas cambiadas (update) o provistas (insert).
    #[serde(default)]
    pub values: HashMap<String, DbValue>,
    /// Valores anteriores de las columnas cambiadas (guard optimista).
    #[serde(default)]
    pub old_values: HashMap<String, DbValue>,
}

pub fn quote_ident(engine: Engine, name: &str) -> String {
    match engine {
        Engine::Mysql | Engine::Mariadb => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn qualified_table(engine: Engine, editability: &Editability) -> Result<String> {
    let table = editability
        .table
        .as_deref()
        .ok_or_else(|| DbError::Other("no target table".into()))?;
    Ok(match &editability.namespace {
        Some(ns) => format!("{}.{}", quote_ident(engine, ns), quote_ident(engine, table)),
        None => quote_ident(engine, table),
    })
}

/// Placeholder para el parámetro n (1-based), con cast explícito en Postgres
/// para los valores que se bindean como texto.
fn placeholder(engine: Engine, n: usize, value: &DbValue) -> String {
    match engine {
        Engine::Postgres => {
            let cast = match value {
                DbValue::Decimal(_) => "::numeric",
                DbValue::Date(_) => "::date",
                DbValue::Time(_) => "::time",
                DbValue::Timestamp(_) => "::timestamptz",
                DbValue::Uuid(_) => "::uuid",
                _ => "",
            };
            format!("${n}{cast}")
        }
        _ => "?".to_string(),
    }
}

/// Representación literal solo para el Code Preview (la ejecución siempre
/// usa bind parameters).
pub fn literal(value: &DbValue) -> String {
    fn quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "''"))
    }
    match value {
        DbValue::Null => "NULL".into(),
        DbValue::Bool(b) => b.to_string().to_uppercase(),
        DbValue::Int(i) => i.to_string(),
        DbValue::Float(f) => f.to_string(),
        DbValue::Decimal(s) => s.clone(),
        DbValue::Text(s)
        | DbValue::Date(s)
        | DbValue::Time(s)
        | DbValue::Timestamp(s)
        | DbValue::Uuid(s) => quote(s),
        DbValue::Json(j) => quote(&j.to_string()),
        DbValue::Bytes(b64) => format!("'<binary base64:{}>'", &b64[..b64.len().min(24)]),
    }
}

struct SqlBuilder {
    engine: Engine,
    sql: String,
    preview: String,
    params: Vec<DbValue>,
}

impl SqlBuilder {
    fn new(engine: Engine) -> Self {
        Self {
            engine,
            sql: String::new(),
            preview: String::new(),
            params: Vec::new(),
        }
    }

    fn push(&mut self, text: &str) {
        self.sql.push_str(text);
        self.preview.push_str(text);
    }

    fn push_value(&mut self, value: &DbValue) {
        self.params.push(value.clone());
        let ph = placeholder(self.engine, self.params.len(), value);
        self.sql.push_str(&ph);
        self.preview.push_str(&literal(value));
    }
}

/// Genera los statements para un batch de cambios. `optimistic_guards`
/// (Safe Mode) añade los valores viejos al WHERE y exige affected_rows == 1.
pub fn build_mutations(
    engine: Engine,
    editability: &Editability,
    changes: &[PendingChange],
    optimistic_guards: bool,
) -> Result<Vec<MutationStatement>> {
    if !editability.editable {
        return Err(DbError::Other(
            editability
                .reason
                .clone()
                .unwrap_or_else(|| "result set is not editable".into()),
        ));
    }
    let table = qualified_table(engine, editability)?;
    let mut statements = Vec::new();

    for change in changes {
        let mut b = SqlBuilder::new(engine);
        match change.kind {
            ChangeKind::Update => {
                if change.values.is_empty() {
                    continue;
                }
                b.push(&format!("UPDATE {table} SET "));
                let mut cols: Vec<_> = change.values.iter().collect();
                cols.sort_by(|a, b| a.0.cmp(b.0));
                for (i, (col, value)) in cols.iter().enumerate() {
                    if i > 0 {
                        b.push(", ");
                    }
                    b.push(&format!("{} = ", quote_ident(engine, col)));
                    b.push_value(value);
                }
                push_where(&mut b, engine, change, editability, optimistic_guards)?;
            }
            ChangeKind::Delete => {
                b.push(&format!("DELETE FROM {table}"));
                push_where(&mut b, engine, change, editability, optimistic_guards)?;
            }
            ChangeKind::Insert => {
                if change.values.is_empty() {
                    continue;
                }
                let mut cols: Vec<_> = change.values.iter().collect();
                cols.sort_by(|a, b| a.0.cmp(b.0));
                b.push(&format!("INSERT INTO {table} ("));
                for (i, (col, _)) in cols.iter().enumerate() {
                    if i > 0 {
                        b.push(", ");
                    }
                    b.push(&quote_ident(engine, col));
                }
                b.push(") VALUES (");
                for (i, (_, value)) in cols.iter().enumerate() {
                    if i > 0 {
                        b.push(", ");
                    }
                    b.push_value(value);
                }
                b.push(")");
            }
        }
        let expected = match change.kind {
            ChangeKind::Insert => None,
            _ => Some(1),
        };
        statements.push(MutationStatement {
            sql: b.sql,
            params: b.params,
            preview_sql: b.preview,
            expected_rows: expected,
        });
    }
    Ok(statements)
}

fn push_where(
    b: &mut SqlBuilder,
    engine: Engine,
    change: &PendingChange,
    editability: &Editability,
    optimistic_guards: bool,
) -> Result<()> {
    if change.pk.is_empty() {
        return Err(DbError::Other("missing primary key values".into()));
    }
    b.push(" WHERE ");
    let mut first = true;
    let mut push_cond = |b: &mut SqlBuilder, col: &str, value: &DbValue| {
        if !first {
            b.push(" AND ");
        }
        first = false;
        if value.is_null() {
            b.push(&format!("{} IS NULL", quote_ident(engine, col)));
        } else {
            b.push(&format!("{} = ", quote_ident(engine, col)));
            b.push_value(value);
        }
    };

    for pk_col in &editability.pk_columns {
        let value = change
            .pk
            .get(pk_col)
            .ok_or_else(|| DbError::Other(format!("missing pk value for {pk_col}")))?;
        push_cond(b, pk_col, value);
    }
    if optimistic_guards {
        let mut old: Vec<_> = change.old_values.iter().collect();
        old.sort_by(|a, b| a.0.cmp(b.0));
        for (col, value) in old {
            if !editability.pk_columns.contains(col) {
                push_cond(b, col, value);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editability() -> Editability {
        Editability {
            editable: true,
            reason: None,
            namespace: Some("public".into()),
            table: Some("customers".into()),
            pk_columns: vec!["id".into()],
            column_sources: HashMap::new(),
        }
    }

    #[test]
    fn update_postgres_with_guard() {
        let change = PendingChange {
            kind: ChangeKind::Update,
            pk: HashMap::from([("id".into(), DbValue::Int(7))]),
            values: HashMap::from([("name".into(), DbValue::Text("Ana".into()))]),
            old_values: HashMap::from([("name".into(), DbValue::Text("Ann".into()))]),
        };
        let st = build_mutations(Engine::Postgres, &editability(), &[change], true).unwrap();
        assert_eq!(st.len(), 1);
        assert_eq!(
            st[0].sql,
            r#"UPDATE "public"."customers" SET "name" = $1 WHERE "id" = $2 AND "name" = $3"#
        );
        assert_eq!(
            st[0].preview_sql,
            r#"UPDATE "public"."customers" SET "name" = 'Ana' WHERE "id" = 7 AND "name" = 'Ann'"#
        );
        assert_eq!(st[0].expected_rows, Some(1));
    }

    #[test]
    fn delete_mysql_quoting() {
        let mut e = editability();
        e.namespace = None;
        let change = PendingChange {
            kind: ChangeKind::Delete,
            pk: HashMap::from([("id".into(), DbValue::Int(1))]),
            values: HashMap::new(),
            old_values: HashMap::new(),
        };
        let st = build_mutations(Engine::Mysql, &e, &[change], false).unwrap();
        assert_eq!(st[0].sql, "DELETE FROM `customers` WHERE `id` = ?");
    }

    #[test]
    fn insert_generates_no_expected_rows() {
        let change = PendingChange {
            kind: ChangeKind::Insert,
            pk: HashMap::new(),
            values: HashMap::from([
                ("name".into(), DbValue::Text("Bruno".into())),
                ("balance".into(), DbValue::Decimal("10.50".into())),
            ]),
            old_values: HashMap::new(),
        };
        let st = build_mutations(Engine::Postgres, &editability(), &[change], true).unwrap();
        assert_eq!(
            st[0].sql,
            r#"INSERT INTO "public"."customers" ("balance", "name") VALUES ($1::numeric, $2)"#
        );
        assert_eq!(st[0].expected_rows, None);
    }

    #[test]
    fn null_pk_uses_is_null() {
        let change = PendingChange {
            kind: ChangeKind::Delete,
            pk: HashMap::from([("id".into(), DbValue::Null)]),
            values: HashMap::new(),
            old_values: HashMap::new(),
        };
        let st = build_mutations(Engine::Postgres, &editability(), &[change], false).unwrap();
        assert_eq!(
            st[0].sql,
            r#"DELETE FROM "public"."customers" WHERE "id" IS NULL"#
        );
    }
}
