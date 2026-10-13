//! Análisis de queries para decidir si el grid de resultados es editable:
//! un solo SELECT sobre una tabla base con PK presente en el result set.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlparser::ast::{Expr, GroupByExpr, Query, SelectItem, SetExpr, Statement, TableFactor};
use sqlparser::dialect::{Dialect, GenericDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

use crate::config::Engine;
use crate::schema::DbSchema;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Editability {
    pub editable: bool,
    /// Si no es editable, por qué (para tooltip en el grid).
    pub reason: Option<String>,
    pub namespace: Option<String>,
    pub table: Option<String>,
    pub pk_columns: Vec<String>,
    /// Columna del resultado -> columna real de la tabla (celdas editables).
    pub column_sources: HashMap<String, String>,
}

impl Editability {
    fn no(reason: &str) -> Self {
        Editability {
            editable: false,
            reason: Some(reason.to_string()),
            ..Default::default()
        }
    }
}

fn dialect_for(engine: Engine) -> Box<dyn Dialect> {
    match engine {
        Engine::Postgres => Box::new(PostgreSqlDialect {}),
        Engine::Mysql | Engine::Mariadb => Box::new(MySqlDialect {}),
        Engine::Sqlite => Box::new(SQLiteDialect {}),
        Engine::Redis => Box::new(GenericDialect {}),
    }
}

pub fn analyze_query(engine: Engine, sql: &str, schema: &DbSchema) -> Editability {
    if engine == Engine::Redis {
        return Editability::no("redis commands are not editable result sets");
    }
    let dialect = dialect_for(engine);
    let statements = match Parser::parse_sql(dialect.as_ref(), sql) {
        Ok(s) => s,
        Err(_) => return Editability::no("could not parse query"),
    };
    if statements.len() != 1 {
        return Editability::no("multiple statements");
    }
    let query = match &statements[0] {
        Statement::Query(q) => q,
        _ => return Editability::no("not a SELECT query"),
    };
    analyze_select(query, schema)
}

fn analyze_select(query: &Query, schema: &DbSchema) -> Editability {
    if query.with.is_some() {
        return Editability::no("CTEs are not editable");
    }
    let select = match query.body.as_ref() {
        SetExpr::Select(s) => s,
        SetExpr::Query(_) => return Editability::no("nested query"),
        SetExpr::SetOperation { .. } => return Editability::no("UNION/INTERSECT/EXCEPT"),
        _ => return Editability::no("not a plain SELECT"),
    };
    if select.distinct.is_some() {
        return Editability::no("DISTINCT");
    }
    if select.having.is_some() {
        return Editability::no("HAVING");
    }
    match &select.group_by {
        GroupByExpr::All(_) => return Editability::no("GROUP BY"),
        GroupByExpr::Expressions(exprs, _) if !exprs.is_empty() => {
            return Editability::no("GROUP BY")
        }
        _ => {}
    }
    if select.from.len() != 1 {
        return Editability::no("multiple tables in FROM");
    }
    let table_ref = &select.from[0];
    if !table_ref.joins.is_empty() {
        return Editability::no("JOIN");
    }
    let (namespace, table_name) = match &table_ref.relation {
        TableFactor::Table { name, .. } => {
            let parts: Vec<String> = name.0.iter().map(|i| i.value.clone()).collect();
            match parts.len() {
                1 => (None, parts[0].clone()),
                2 => (Some(parts[0].clone()), parts[1].clone()),
                _ => return Editability::no("qualified name too deep"),
            }
        }
        TableFactor::Derived { .. } => return Editability::no("subquery in FROM"),
        _ => return Editability::no("unsupported FROM clause"),
    };

    let table = match schema.find_table(namespace.as_deref(), &table_name) {
        Some(t) => t,
        None => return Editability::no("table not found in schema (refresh schema?)"),
    };
    if table.primary_key.is_empty() {
        return Editability::no("table has no primary key");
    }

    // Mapear columnas del resultado a columnas reales.
    let mut column_sources: HashMap<String, String> = HashMap::new();
    for item in &select.projection {
        match item {
            SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _) => {
                for col in &table.columns {
                    column_sources.insert(col.name.clone(), col.name.clone());
                }
            }
            SelectItem::UnnamedExpr(expr) => {
                if let Some(col) = direct_column(expr) {
                    column_sources.insert(col.clone(), col);
                }
                // Expresiones (price * 2, funciones…) quedan read-only:
                // simplemente no aparecen en column_sources.
            }
            SelectItem::ExprWithAlias { expr, alias } => {
                if let Some(col) = direct_column(expr) {
                    column_sources.insert(alias.value.clone(), col);
                }
            }
        }
    }

    // Todas las columnas de la PK deben estar presentes en el resultado.
    let missing_pk: Vec<&String> = table
        .primary_key
        .iter()
        .filter(|pk| !column_sources.values().any(|src| src == *pk))
        .collect();
    if !missing_pk.is_empty() {
        return Editability::no("primary key column(s) missing from result set");
    }

    Editability {
        editable: true,
        reason: None,
        namespace,
        table: Some(table_name),
        pk_columns: table.primary_key.clone(),
        column_sources,
    }
}

/// Detecta statements que modifican datos escritos a mano, para que Safe
/// Mode pida confirmación explícita antes de ejecutar CUALQUIER mutación
/// (UPDATE/DELETE/INSERT con o sin WHERE, TRUNCATE, DROP, ALTER).
pub fn dangerous_statements(engine: Engine, sql: &str) -> Vec<String> {
    let dialect = dialect_for(engine);
    let statements = match Parser::parse_sql(dialect.as_ref(), sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let mut warnings = Vec::new();
    for st in &statements {
        match st {
            Statement::Update { selection, .. } => {
                warnings.push(if selection.is_none() {
                    "UPDATE without WHERE affects EVERY row".to_string()
                } else {
                    "UPDATE statement".to_string()
                });
            }
            Statement::Delete(del) => {
                warnings.push(if del.selection.is_none() {
                    "DELETE without WHERE affects EVERY row".to_string()
                } else {
                    "DELETE statement".to_string()
                });
            }
            Statement::Insert(_) => {
                warnings.push("INSERT statement".to_string());
            }
            Statement::Truncate { .. } => {
                warnings.push("TRUNCATE removes all rows".to_string());
            }
            Statement::Drop { .. } => {
                warnings.push("DROP is irreversible".to_string());
            }
            Statement::AlterTable { .. } => {
                warnings.push("ALTER TABLE changes the structure".to_string());
            }
            _ => {}
        }
    }
    warnings
}

fn direct_column(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Identifier(ident) => Some(ident.value.clone()),
        Expr::CompoundIdentifier(parts) => parts.last().map(|i| i.value.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{Column, Namespace, Table, TableKind};

    fn schema() -> DbSchema {
        DbSchema {
            namespaces: vec![Namespace {
                name: "public".into(),
                tables: vec![
                    Table {
                        name: "customers".into(),
                        kind: TableKind::Table,
                        columns: ["id", "name", "email"]
                            .iter()
                            .map(|c| Column {
                                name: c.to_string(),
                                db_type: "text".into(),
                                nullable: false,
                                is_pk: *c == "id",
                            })
                            .collect(),
                        primary_key: vec!["id".into()],
                    },
                    Table {
                        name: "audit_log".into(),
                        kind: TableKind::Table,
                        columns: vec![Column {
                            name: "event".into(),
                            db_type: "text".into(),
                            nullable: false,
                            is_pk: false,
                        }],
                        primary_key: vec![],
                    },
                ],
            }],
        }
    }

    #[test]
    fn select_star_editable() {
        let e = analyze_query(Engine::Postgres, "SELECT * FROM customers", &schema());
        assert!(e.editable, "{:?}", e.reason);
        assert_eq!(e.pk_columns, vec!["id"]);
        assert_eq!(e.column_sources.len(), 3);
    }

    #[test]
    fn join_not_editable() {
        let e = analyze_query(
            Engine::Postgres,
            "SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id",
            &schema(),
        );
        assert!(!e.editable);
    }

    #[test]
    fn missing_pk_column_not_editable() {
        let e = analyze_query(Engine::Postgres, "SELECT name FROM customers", &schema());
        assert!(!e.editable);
    }

    #[test]
    fn no_pk_table_not_editable() {
        let e = analyze_query(Engine::Postgres, "SELECT * FROM audit_log", &schema());
        assert!(!e.editable);
    }

    #[test]
    fn expression_column_readonly_but_row_editable() {
        let e = analyze_query(
            Engine::Postgres,
            "SELECT id, name, length(email) AS l FROM customers",
            &schema(),
        );
        assert!(e.editable, "{:?}", e.reason);
        assert!(!e.column_sources.contains_key("l"));
    }

    #[test]
    fn aggregate_query_not_editable() {
        let e = analyze_query(
            Engine::Postgres,
            "SELECT name FROM customers GROUP BY name",
            &schema(),
        );
        assert!(!e.editable);
    }

    #[test]
    fn safe_mode_flags_all_mutations() {
        for sql in [
            "UPDATE customers SET name = 'x'",
            "UPDATE customers SET name = 'x' WHERE id = 1",
            "DELETE FROM customers WHERE id = 1",
            "INSERT INTO customers (name) VALUES ('x')",
            "TRUNCATE customers",
        ] {
            assert!(
                !dangerous_statements(Engine::Postgres, sql).is_empty(),
                "should flag: {sql}"
            );
        }
        assert!(dangerous_statements(Engine::Postgres, "SELECT 1").is_empty());
    }

    #[test]
    fn update_not_editable() {
        let e = analyze_query(
            Engine::Postgres,
            "UPDATE customers SET name = 'x'",
            &schema(),
        );
        assert!(!e.editable);
    }
}
