//! Análisis de queries para decidir qué celdas del grid de resultados son
//! editables: un solo SELECT (con o sin JOIN) donde cada tabla real cuya PK
//! está completa en el result set puede editarse.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sqlparser::ast::{
    Expr, GroupByExpr, Ident, JoinConstraint, JoinOperator, Query, SelectItem, SetExpr, Statement,
    TableFactor, TableWithJoins, WildcardAdditionalOptions,
};
use sqlparser::dialect::{Dialect, GenericDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

use crate::config::Engine;
use crate::schema::{DbSchema, Table};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Editability {
    /// Hay al menos una tabla editable.
    pub editable: bool,
    /// Si no es editable, por qué (para tooltip en el grid).
    pub reason: Option<String>,
    /// Tablas reales del FROM/JOIN, en orden de aparición.
    pub targets: Vec<EditTarget>,
    /// Una entrada por columna del resultado, en el mismo orden.
    pub columns: Vec<ResultColumn>,
    /// Tabla sobre la que se pueden insertar/borrar filas (sólo sin JOIN).
    pub row_target: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTarget {
    pub namespace: Option<String>,
    pub table: String,
    /// Alias en la query (`ventas AS v` → `v`).
    pub alias: Option<String>,
    pub pk_columns: Vec<String>,
    /// Índice en el resultado de cada columna de `pk_columns` (mismo orden).
    pub pk_indexes: Vec<usize>,
    pub editable: bool,
    /// Si no es editable, por qué.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    /// Nombre que debería devolver el motor (None = expresión, no se comprueba).
    pub name: Option<String>,
    /// Columna real de la que viene (None = expresión o no resoluble: read-only).
    pub source: Option<ColumnSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSource {
    /// Índice en `Editability::targets`.
    pub target: usize,
    pub column: String,
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

/// Una relación del FROM/JOIN.
struct Relation<'a> {
    /// Nombre con el que se la referencia: alias o nombre de la tabla.
    ref_name: String,
    /// Namespace escrito en la query (sólo si no hay alias).
    ref_namespace: Option<String>,
    /// Tabla real del schema (None = subquery, CTE, función o desconocida).
    table: Option<&'a Table>,
    /// Índice en `targets` si es una tabla real.
    target: Option<usize>,
}

fn eq_ident(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn alias_name(alias: &Option<sqlparser::ast::TableAlias>) -> Option<String> {
    alias.as_ref().map(|a| a.name.value.clone())
}

/// Busca la tabla sin distinguir mayúsculas (prefiere la coincidencia exacta).
fn find_table<'a>(schema: &'a DbSchema, namespace: Option<&str>, name: &str) -> Option<&'a Table> {
    if let Some(t) = schema.find_table(namespace, name) {
        return Some(t);
    }
    schema
        .namespaces
        .iter()
        .filter(|n| namespace.is_none_or(|ns| eq_ident(&n.name, ns)))
        .flat_map(|n| n.tables.iter())
        .find(|t| eq_ident(&t.name, name))
}

/// Columna real de la tabla (nombre del schema), sin distinguir mayúsculas.
fn table_column(table: &Table, name: &str) -> Option<String> {
    table
        .columns
        .iter()
        .find(|c| c.name == name)
        .or_else(|| table.columns.iter().find(|c| eq_ident(&c.name, name)))
        .map(|c| c.name.clone())
}

fn analyze_select(query: &Query, schema: &DbSchema) -> Editability {
    // Los nombres de CTE tapan a las tablas reales: sus columnas son read-only.
    let cte_names: HashSet<String> = query
        .with
        .as_ref()
        .map(|w| {
            w.cte_tables
                .iter()
                .map(|c| c.alias.name.value.to_lowercase())
                .collect()
        })
        .unwrap_or_default();
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
    if select.from.is_empty() {
        return Editability::no("no table in FROM");
    }

    // Relaciones del FROM y los JOIN, en orden.
    let mut targets: Vec<EditTarget> = Vec::new();
    let mut relations: Vec<Relation> = Vec::new();
    // USING/NATURAL fusionan columnas: `*` deja de ser la suma de las tablas.
    let mut merges_columns = false;
    let mut has_joins = false;
    for twj in &select.from {
        let TableWithJoins { relation, joins } = twj;
        add_relation(relation, schema, &cte_names, &mut relations, &mut targets);
        for join in joins {
            has_joins = true;
            let constraint = match &join.join_operator {
                JoinOperator::Inner(c)
                | JoinOperator::LeftOuter(c)
                | JoinOperator::RightOuter(c)
                | JoinOperator::FullOuter(c) => Some(c),
                JoinOperator::CrossJoin => None,
                _ => return Editability::no("unsupported JOIN type"),
            };
            if matches!(
                constraint,
                Some(JoinConstraint::Using(_) | JoinConstraint::Natural)
            ) {
                merges_columns = true;
            }
            add_relation(
                &join.relation,
                schema,
                &cte_names,
                &mut relations,
                &mut targets,
            );
        }
    }

    // Mapear cada columna del resultado a su origen.
    let mut columns: Vec<ResultColumn> = Vec::new();
    for item in &select.projection {
        match item {
            SelectItem::Wildcard(opts) => {
                if has_wildcard_modifiers(opts) {
                    return Editability::no("wildcard modifiers");
                }
                if merges_columns {
                    return Editability::no("* with JOIN USING/NATURAL");
                }
                for rel in &relations {
                    if let Err(reason) = expand_relation(rel, &mut columns) {
                        return Editability::no(reason);
                    }
                }
            }
            SelectItem::QualifiedWildcard(name, opts) => {
                if has_wildcard_modifiers(opts) {
                    return Editability::no("wildcard modifiers");
                }
                let Some(rel) = find_relation(&relations, &name.0) else {
                    return Editability::no("unknown table in qualified *");
                };
                if let Err(reason) = expand_relation(rel, &mut columns) {
                    return Editability::no(reason);
                }
            }
            SelectItem::UnnamedExpr(expr) => columns.push(ResultColumn {
                name: expr_name(expr),
                source: resolve_column(expr, &relations),
            }),
            SelectItem::ExprWithAlias { expr, alias } => columns.push(ResultColumn {
                name: Some(alias.value.clone()),
                source: resolve_column(expr, &relations),
            }),
        }
    }

    // Una tabla es editable si su PK completa está en el resultado.
    for (ti, target) in targets.iter_mut().enumerate() {
        let label = target.alias.clone().unwrap_or_else(|| target.table.clone());
        if target.pk_columns.is_empty() {
            target.reason = Some(format!("{} has no primary key", target.table));
            continue;
        }
        let mut missing = Vec::new();
        for pk in &target.pk_columns {
            let idx = columns.iter().position(|c| {
                c.source
                    .as_ref()
                    .is_some_and(|s| s.target == ti && &s.column == pk)
            });
            match idx {
                Some(i) => target.pk_indexes.push(i),
                None => missing.push(format!("{label}.{pk}")),
            }
        }
        if missing.is_empty() {
            target.editable = true;
        } else {
            target.pk_indexes.clear();
            target.reason = Some(format!(
                "add {} to the SELECT to edit {}",
                missing.join(", "),
                target.table
            ));
        }
    }

    let used: HashSet<usize> = columns
        .iter()
        .filter_map(|c| c.source.as_ref().map(|s| s.target))
        .collect();
    let editable = targets
        .iter()
        .enumerate()
        .any(|(i, t)| t.editable && used.contains(&i));
    let reason = if editable {
        None
    } else if targets.is_empty() {
        Some(if relations.len() == 1 {
            "table not found in schema (refresh schema?)".to_string()
        } else {
            "no known table in FROM (refresh schema?)".to_string()
        })
    } else if targets.len() == 1 && relations.len() == 1 {
        targets[0].reason.clone()
    } else {
        Some(
            targets
                .iter()
                .filter_map(|t| t.reason.clone())
                .collect::<Vec<_>>()
                .join("; "),
        )
        .filter(|s| !s.is_empty())
        .or_else(|| Some("no editable column in the result set".into()))
    };
    // Insertar/borrar filas sólo tiene sentido con una única tabla.
    let row_target =
        (editable && !has_joins && relations.len() == 1 && targets.len() == 1).then_some(0);

    Editability {
        editable,
        reason,
        targets,
        columns,
        row_target,
    }
}

fn add_relation<'a>(
    factor: &TableFactor,
    schema: &'a DbSchema,
    cte_names: &HashSet<String>,
    relations: &mut Vec<Relation<'a>>,
    targets: &mut Vec<EditTarget>,
) {
    match factor {
        TableFactor::Table {
            name, alias, args, ..
        } => {
            let parts: Vec<String> = name.0.iter().map(|i| i.value.clone()).collect();
            let table_name = parts.last().cloned().unwrap_or_default();
            let namespace = (parts.len() >= 2).then(|| parts[parts.len() - 2].clone());
            let alias_cols = alias.as_ref().is_some_and(|a| !a.columns.is_empty());
            let is_cte = parts.len() == 1 && cte_names.contains(&table_name.to_lowercase());
            let table = if args.is_some() || alias_cols || is_cte {
                None
            } else {
                find_table(schema, namespace.as_deref(), &table_name)
            };
            let target = table.map(|t| {
                targets.push(EditTarget {
                    namespace: namespace.clone(),
                    table: t.name.clone(),
                    alias: alias_name(alias),
                    pk_columns: t.primary_key.clone(),
                    ..Default::default()
                });
                targets.len() - 1
            });
            let aliased = alias.is_some();
            relations.push(Relation {
                ref_name: alias_name(alias).unwrap_or(table_name),
                ref_namespace: if aliased { None } else { namespace },
                table,
                target,
            });
        }
        TableFactor::Derived { alias, .. }
        | TableFactor::TableFunction { alias, .. }
        | TableFactor::Function { alias, .. }
        | TableFactor::UNNEST { alias, .. } => relations.push(Relation {
            ref_name: alias_name(alias).unwrap_or_default(),
            ref_namespace: None,
            table: None,
            target: None,
        }),
        TableFactor::NestedJoin {
            table_with_joins, ..
        } => {
            add_relation(
                &table_with_joins.relation,
                schema,
                cte_names,
                relations,
                targets,
            );
            for j in &table_with_joins.joins {
                add_relation(&j.relation, schema, cte_names, relations, targets);
            }
        }
        _ => relations.push(Relation {
            ref_name: String::new(),
            ref_namespace: None,
            table: None,
            target: None,
        }),
    }
}

fn has_wildcard_modifiers(opts: &WildcardAdditionalOptions) -> bool {
    opts.opt_ilike.is_some()
        || opts.opt_exclude.is_some()
        || opts.opt_except.is_some()
        || opts.opt_replace.is_some()
        || opts.opt_rename.is_some()
}

/// Expande `*` / `t.*` de una relación; sin tabla conocida no sabemos cuántas
/// columnas aporta y el resto de posiciones quedaría desalineado.
fn expand_relation(rel: &Relation, columns: &mut Vec<ResultColumn>) -> Result<(), &'static str> {
    let (Some(table), Some(target)) = (rel.table, rel.target) else {
        return Err("* over a subquery or unknown table");
    };
    for col in &table.columns {
        columns.push(ResultColumn {
            name: Some(col.name.clone()),
            source: Some(ColumnSource {
                target,
                column: col.name.clone(),
            }),
        });
    }
    Ok(())
}

/// Relación a la que se refiere un calificador (`v`, `ventas`, `public.ventas`).
fn find_relation<'r, 'a>(
    relations: &'r [Relation<'a>],
    qualifier: &[Ident],
) -> Option<&'r Relation<'a>> {
    let last = qualifier.last()?;
    let ns = (qualifier.len() >= 2).then(|| &qualifier[qualifier.len() - 2]);
    let mut found = relations.iter().filter(|r| {
        eq_ident(&r.ref_name, &last.value)
            && match (ns, &r.ref_namespace) {
                (Some(q), Some(n)) => eq_ident(&q.value, n),
                _ => true,
            }
    });
    let first = found.next()?;
    // Dos relaciones con el mismo nombre: ambigua.
    found.next().is_none().then_some(first)
}

/// Nombre que el motor da a una columna sin alias.
fn expr_name(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Identifier(ident) => Some(ident.value.clone()),
        Expr::CompoundIdentifier(parts) => parts.last().map(|i| i.value.clone()),
        _ => None,
    }
}

fn resolve_column(expr: &Expr, relations: &[Relation]) -> Option<ColumnSource> {
    match expr {
        Expr::Identifier(ident) => {
            // Sin calificador: la única relación que puede tenerla. Si hay una
            // subquery/CTE no sabemos qué columnas tiene: ambigua.
            if relations.iter().any(|r| r.table.is_none()) {
                return None;
            }
            let mut hits = relations
                .iter()
                .filter_map(|r| Some((r.target?, table_column(r.table?, &ident.value)?)));
            let (target, column) = hits.next()?;
            hits.next()
                .is_none()
                .then_some(ColumnSource { target, column })
        }
        Expr::CompoundIdentifier(parts) if parts.len() >= 2 => {
            let (col, qualifier) = parts.split_last()?;
            let rel = find_relation(relations, qualifier)?;
            Some(ColumnSource {
                target: rel.target?,
                column: table_column(rel.table?, &col.value)?,
            })
        }
        Expr::Nested(inner) => resolve_column(inner, relations),
        _ => None,
    }
}

/// Detecta statements que modifican datos escritos a mano, para que Safe
/// Mode pida confirmación explícita antes de ejecutar CUALQUIER mutación
/// (UPDATE/DELETE/INSERT con o sin WHERE, TRUNCATE, DROP, ALTER).
/// True si el script se puede volver a ejecutar sin efectos: todos sus
/// statements se parsean y son consultas (SELECT/VALUES/TABLE/SHOW) sin
/// `SELECT ... INTO` ni CTEs que modifiquen datos. Ante la duda, false.
pub fn is_read_only(engine: Engine, sql: &str) -> bool {
    if engine == Engine::Redis {
        return false;
    }
    let dialect = dialect_for(engine);
    let Ok(statements) = Parser::parse_sql(dialect.as_ref(), sql) else {
        return false;
    };
    !statements.is_empty()
        && statements.iter().all(|st| match st {
            Statement::Query(q) => query_is_read_only(q),
            Statement::ShowTables { .. }
            | Statement::ShowColumns { .. }
            | Statement::ShowVariable { .. }
            | Statement::ShowVariables { .. }
            | Statement::ShowCreate { .. }
            | Statement::ShowFunctions { .. }
            | Statement::ShowStatus { .. }
            | Statement::ShowDatabases { .. }
            | Statement::ShowSchemas { .. }
            | Statement::ShowViews { .. }
            | Statement::ShowCollation { .. } => true,
            _ => false,
        })
}

fn query_is_read_only(q: &Query) -> bool {
    let ctes_ok = q
        .with
        .as_ref()
        .is_none_or(|w| w.cte_tables.iter().all(|c| query_is_read_only(&c.query)));
    ctes_ok && set_expr_is_read_only(&q.body)
}

fn set_expr_is_read_only(body: &SetExpr) -> bool {
    match body {
        SetExpr::Select(sel) => sel.into.is_none(),
        SetExpr::Query(q) => query_is_read_only(q),
        SetExpr::SetOperation { left, right, .. } => {
            set_expr_is_read_only(left) && set_expr_is_read_only(right)
        }
        SetExpr::Values(_) | SetExpr::Table(_) => true,
        SetExpr::Insert(_) | SetExpr::Update(_) => false,
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_only_for_pure_queries() {
        let pg = Engine::Postgres;
        assert!(is_read_only(pg, "SELECT * FROM t WHERE id > 3"));
        assert!(is_read_only(pg, "SELECT 1; SELECT 2 UNION SELECT 3"));
        assert!(is_read_only(pg, "WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!is_read_only(pg, "UPDATE t SET a = 1 RETURNING *"));
        assert!(!is_read_only(pg, "INSERT INTO t VALUES (1) RETURNING id"));
        assert!(!is_read_only(pg, "SELECT * INTO copia FROM t"));
        assert!(!is_read_only(pg, "SELECT 1; DELETE FROM t"));
        assert!(!is_read_only(
            pg,
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"
        ));
        assert!(!is_read_only(pg, "SELEC mal escrito"));
        assert!(is_read_only(Engine::Mysql, "SHOW TABLES"));
    }
    use crate::schema::{Column, Namespace, Table, TableKind};

    fn table(name: &str, cols: &[&str]) -> Table {
        Table {
            name: name.into(),
            kind: TableKind::Table,
            columns: cols
                .iter()
                .map(|c| Column {
                    name: c.to_string(),
                    db_type: "text".into(),
                    nullable: true,
                    is_pk: *c == "id",
                })
                .collect(),
            primary_key: vec!["id".into()],
        }
    }

    fn src(e: &Editability, i: usize) -> Option<(usize, &str)> {
        e.columns[i]
            .source
            .as_ref()
            .map(|s| (s.target, s.column.as_str()))
    }

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
                    table("ventas", &["id", "secuencial", "entidad_id", "anulada"]),
                    table("entidades", &["id", "nombre_comercial"]),
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
        assert_eq!(e.targets[0].pk_columns, vec!["id"]);
        assert_eq!(e.targets[0].pk_indexes, vec![0]);
        assert_eq!(e.columns.len(), 3);
        assert_eq!(e.row_target, Some(0));
    }

    #[test]
    fn join_without_other_pk_edits_only_base_table() {
        let e = analyze_query(
            Engine::Postgres,
            "SELECT v.id, secuencial, anulada, e.nombre_comercial \
             FROM ventas AS v INNER JOIN entidades AS e ON (e.id = v.entidad_id) LIMIT 10",
            &schema(),
        );
        assert!(e.editable, "{:?}", e.reason);
        assert_eq!(e.targets.len(), 2);
        assert!(e.targets[0].editable);
        assert!(!e.targets[1].editable);
        assert_eq!(
            e.targets[1].reason.as_deref(),
            Some("add e.id to the SELECT to edit entidades")
        );
        assert_eq!(src(&e, 0), Some((0, "id")));
        assert_eq!(src(&e, 1), Some((0, "secuencial")));
        assert_eq!(src(&e, 3), Some((1, "nombre_comercial")));
        // Con JOIN no se insertan ni borran filas.
        assert_eq!(e.row_target, None);
    }

    #[test]
    fn join_with_both_pks_edits_both_tables() {
        let e = analyze_query(
            Engine::Mysql,
            "SELECT v.id, e.id AS eid, e.nombre_comercial FROM ventas v \
             LEFT JOIN entidades e ON e.id = v.entidad_id",
            &schema(),
        );
        assert!(e.targets[0].editable && e.targets[1].editable);
        assert_eq!(e.targets[1].pk_indexes, vec![1]);
        assert_eq!(e.columns[1].name.as_deref(), Some("eid"));
    }

    #[test]
    fn star_over_join_expands_in_from_order() {
        let e = analyze_query(
            Engine::Postgres,
            "SELECT * FROM ventas v JOIN entidades e ON e.id = v.entidad_id",
            &schema(),
        );
        assert!(e.targets[0].editable && e.targets[1].editable);
        assert_eq!(e.columns.len(), 6);
        assert_eq!(src(&e, 4), Some((1, "id")));
        assert_eq!(e.targets[1].pk_indexes, vec![4]);
    }

    #[test]
    fn duplicated_columns_keep_positions() {
        let e = analyze_query(
            Engine::Postgres,
            "SELECT id, secuencial, * FROM ventas",
            &schema(),
        );
        assert!(e.editable, "{:?}", e.reason);
        assert_eq!(e.columns.len(), 6);
        assert_eq!(src(&e, 2), Some((0, "id")));
        assert_eq!(e.targets[0].pk_indexes, vec![0]);
    }

    #[test]
    fn ambiguous_unqualified_column_is_read_only() {
        let e = analyze_query(
            Engine::Postgres,
            "SELECT v.id, id FROM ventas v JOIN entidades e ON e.id = v.entidad_id",
            &schema(),
        );
        assert!(e.columns[1].source.is_none());
    }

    #[test]
    fn self_join_distinguishes_aliases() {
        let e = analyze_query(
            Engine::Postgres,
            "SELECT a.id, a.secuencial, b.id, b.secuencial FROM ventas a JOIN ventas b ON b.id = a.id + 1",
            &schema(),
        );
        assert!(e.targets[0].editable && e.targets[1].editable);
        assert_eq!(src(&e, 3), Some((1, "secuencial")));
    }

    #[test]
    fn subquery_join_keeps_table_columns_editable() {
        let e = analyze_query(
            Engine::Postgres,
            "SELECT v.id, v.anulada, x.n FROM ventas v JOIN (SELECT 1 AS n) x ON true",
            &schema(),
        );
        assert!(e.editable, "{:?}", e.reason);
        assert_eq!(src(&e, 1), Some((0, "anulada")));
        assert!(e.columns[2].source.is_none());
    }

    #[test]
    fn star_with_using_is_not_editable() {
        let e = analyze_query(
            Engine::Postgres,
            "SELECT * FROM ventas JOIN entidades USING (id)",
            &schema(),
        );
        assert!(!e.editable);
    }

    #[test]
    fn cte_name_is_not_a_table() {
        let e = analyze_query(
            Engine::Postgres,
            "WITH ventas AS (SELECT 1 AS id) SELECT id FROM ventas",
            &schema(),
        );
        assert!(!e.editable);
        let e = analyze_query(
            Engine::Postgres,
            "WITH x AS (SELECT 1 AS n) SELECT v.id, v.anulada FROM ventas v JOIN x ON true",
            &schema(),
        );
        assert!(e.editable, "{:?}", e.reason);
    }

    #[test]
    fn case_insensitive_identifiers() {
        let e = analyze_query(
            Engine::Mysql,
            "SELECT ID, Secuencial FROM VENTAS",
            &schema(),
        );
        assert!(e.editable, "{:?}", e.reason);
        assert_eq!(src(&e, 1), Some((0, "secuencial")));
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
        assert!(e.columns[2].source.is_none());
        assert_eq!(e.columns[2].name.as_deref(), Some("l"));
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
