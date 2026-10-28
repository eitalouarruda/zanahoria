//! Plan de restore: con el dump (formato y versiones de origen), las
//! herramientas disponibles y la versión del servidor destino decide cómo
//! restaurar y qué correcciones de compatibilidad aplicar.

use std::collections::BTreeMap;

use db_core::Engine;
use serde::Serialize;

use crate::compat::SqlFilter;
use crate::detect::ToolStatus;
use crate::sniff::{DumpKind, SniffResult};
use crate::version::{
    max_archive_version, min_tool_for_archive, pg_major, pg_major_label, version_num,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    /// pg_restore directo contra el servidor (paralelo con -j).
    Direct,
    /// pg_restore → SQL → filtro de compatibilidad → psql. Para servidores
    /// más viejos que el pg_restore (que escribe SETs que no conocen) o
    /// dumps de servidores más nuevos que el destino.
    Compat,
    /// Script SQL plano (psql / mysql) pasando por el filtro.
    Script,
}

/// Aviso o bloqueo con código (traducido en el frontend) y parámetros.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlanNote {
    pub code: String,
    pub params: BTreeMap<String, String>,
}

impl PlanNote {
    fn new(code: &str, params: &[(&str, String)]) -> Self {
        Self {
            code: code.to_string(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        }
    }
}

/// Estado del servidor/database destino (lo consulta la capa de comandos).
#[derive(Debug, Clone, Default)]
pub struct TargetInfo {
    /// `SHOW server_version` / `SELECT VERSION()`; None si no se pudo leer.
    pub version: Option<String>,
    pub exists: bool,
    /// Tablas de usuario ya presentes en la database destino.
    pub tables: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlan {
    pub sniff: SniffResult,
    pub strategy: Strategy,
    /// Herramienta principal ("pg_restore" | "psql" | "mysql") y su versión.
    pub tool: Option<String>,
    pub tool_version: Option<String>,
    pub target_version: Option<String>,
    pub target_exists: bool,
    pub target_tables: Option<i64>,
    /// Correcciones de compatibilidad que se aplicarán (códigos).
    pub fixes: Vec<String>,
    pub warnings: Vec<PlanNote>,
    /// Si hay bloqueo, el restore no se puede iniciar.
    pub blocker: Option<PlanNote>,
    #[serde(skip)]
    pub(crate) filter: Option<SqlFilter>,
}

fn tool<'a>(tools: &'a [ToolStatus], name: &str) -> Option<&'a ToolStatus> {
    tools.iter().find(|t| t.name == name && t.path.is_some())
}

pub fn plan_restore(
    engine: Engine,
    sniff: &SniffResult,
    tools: &[ToolStatus],
    target: &TargetInfo,
    create_db: bool,
    target_db: &str,
) -> RestorePlan {
    let mut plan = RestorePlan {
        sniff: sniff.clone(),
        strategy: Strategy::Script,
        tool: None,
        tool_version: None,
        target_version: target.version.clone(),
        target_exists: target.exists,
        target_tables: target.tables,
        fixes: Vec::new(),
        warnings: Vec::new(),
        blocker: None,
        filter: None,
    };
    let target_num = target.version.as_deref().and_then(version_num);
    let source_num = sniff.source_version.as_deref().and_then(version_num);

    if !target.exists {
        if create_db {
            plan.warnings.push(PlanNote::new(
                "target_will_be_created",
                &[("db", target_db.into())],
            ));
        } else {
            plan.blocker = Some(PlanNote::new("target_missing", &[("db", target_db.into())]));
        }
    } else if let Some(n) = target.tables.filter(|n| *n > 0) {
        plan.warnings.push(PlanNote::new(
            "target_not_empty",
            &[("tables", n.to_string())],
        ));
    }
    if target_num.is_none() {
        plan.warnings
            .push(PlanNote::new("target_version_unknown", &[]));
    }

    let pg_target = matches!(engine, Engine::Postgres);
    let source_engine = sniff.source_engine.as_deref();
    let mismatch = match source_engine {
        Some("postgres") => !pg_target,
        Some("mysql" | "mariadb") => pg_target,
        _ => false,
    };
    if mismatch {
        plan.warnings.push(PlanNote::new(
            "engine_mismatch",
            &[("source", source_engine.unwrap_or_default().into())],
        ));
    }

    let block = |plan: &mut RestorePlan, code: &str, params: &[(&str, String)]| {
        if plan.blocker.is_none() {
            plan.blocker = Some(PlanNote::new(code, params));
        }
    };

    match engine {
        Engine::Postgres => {
            if let (Some(s), Some(t)) = (source_num, target_num) {
                if pg_major(s) > pg_major(t) {
                    plan.warnings.push(PlanNote::new(
                        "downgrade",
                        &[("source", pg_major_label(s)), ("target", pg_major_label(t))],
                    ));
                }
            }
            let psql = tool(tools, "psql");
            let psql_num = psql.and_then(|t| t.version_num()).unwrap_or(0);
            match sniff.kind {
                DumpKind::PgCustom | DumpKind::PgTar | DumpKind::PgDirectory => {
                    let Some(restore) = tool(tools, "pg_restore") else {
                        block(&mut plan, "tool_missing", &[("tool", "pg_restore".into())]);
                        return plan;
                    };
                    plan.tool = Some("pg_restore".into());
                    plan.tool_version = restore.version.clone();
                    let tool_num = restore.version_num().unwrap_or(0);
                    if let Some(archive) = sniff.archive() {
                        if tool_num > 0 && archive > max_archive_version(tool_num) {
                            block(
                                &mut plan,
                                "archive_too_new",
                                &[
                                    ("archive", format!("{}.{}", archive.0, archive.1)),
                                    ("tool", pg_major_label(tool_num)),
                                    ("need", min_tool_for_archive(archive).into()),
                                ],
                            );
                        }
                    }
                    // pg_restore escribe SETs de su propia versión: contra un
                    // servidor más viejo (o desconocido) hay que filtrar.
                    let direct = matches!(target_num, Some(t) if pg_major(t) >= pg_major(tool_num));
                    if direct {
                        plan.strategy = Strategy::Direct;
                    } else {
                        plan.strategy = Strategy::Compat;
                        if psql.is_none() {
                            block(&mut plan, "tool_missing", &[("tool", "psql".into())]);
                        }
                        plan.filter = Some(SqlFilter::postgres(target_num.unwrap_or(0), psql_num));
                    }
                }
                DumpKind::PlainSql => {
                    plan.strategy = Strategy::Script;
                    plan.tool = Some("psql".into());
                    plan.tool_version = psql.and_then(|t| t.version.clone());
                    if psql.is_none() {
                        block(&mut plan, "tool_missing", &[("tool", "psql".into())]);
                    }
                    plan.filter = Some(SqlFilter::postgres(target_num.unwrap_or(0), psql_num));
                }
                DumpKind::Unknown => block(&mut plan, "unknown_format", &[]),
            }
        }
        Engine::Mysql | Engine::Mariadb => {
            plan.strategy = Strategy::Script;
            plan.tool = Some("mysql".into());
            let mysql = tool(tools, "mysql");
            plan.tool_version = mysql.and_then(|t| t.version.clone());
            if mysql.is_none() {
                block(&mut plan, "tool_missing", &[("tool", "mysql".into())]);
            }
            if sniff.kind != DumpKind::PlainSql {
                block(&mut plan, "unknown_format", &[]);
            }
            let target_mariadb = matches!(engine, Engine::Mariadb)
                || target
                    .version
                    .as_deref()
                    .is_some_and(|v| v.to_lowercase().contains("mariadb"));
            // utf8mb4_0900_* solo existe en MySQL ≥ 8.0.
            let no_0900 = target_mariadb || target_num.is_some_and(|t| t < 80000);
            plan.filter = Some(SqlFilter::mysql(no_0900));
        }
        _ => block(&mut plan, "unsupported_engine", &[]),
    }

    if let Some(f) = &plan.filter {
        plan.fixes = f.planned_fixes();
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools(version: &str) -> Vec<ToolStatus> {
        ["pg_restore", "psql", "pg_dump"]
            .iter()
            .map(|n| ToolStatus {
                name: n.to_string(),
                path: Some(format!("/usr/bin/{n}")),
                version: Some(format!("{n} (PostgreSQL) {version}")),
            })
            .collect()
    }

    fn archive(version: &str, source: &str) -> SniffResult {
        SniffResult {
            kind: DumpKind::PgCustom,
            compressed: false,
            restore_tool: Some("pg_restore".into()),
            note: String::new(),
            archive_version: Some(version.into()),
            source_engine: Some("postgres".into()),
            source_version: Some(source.into()),
            dumped_by: None,
            source_db: None,
            size: None,
        }
    }

    fn target(version: &str) -> TargetInfo {
        TargetInfo {
            version: Some(version.into()),
            exists: true,
            tables: Some(0),
        }
    }

    #[test]
    fn same_major_goes_direct() {
        let p = plan_restore(
            Engine::Postgres,
            &archive("1.16", "18.3"),
            &tools("18.6"),
            &target("18.6 (Debian)"),
            true,
            "nt",
        );
        assert_eq!(p.strategy, Strategy::Direct);
        assert!(p.blocker.is_none());
        assert!(p.fixes.is_empty());
    }

    #[test]
    fn old_server_uses_compat_filter() {
        // Caso real: dump de 9.0.5 restaurado en 9.6 con pg_restore 18.
        let p = plan_restore(
            Engine::Postgres,
            &archive("1.12", "9.0.5"),
            &tools("18.6"),
            &target("9.6.24"),
            true,
            "candelaria",
        );
        assert_eq!(p.strategy, Strategy::Compat);
        assert!(p.fixes.contains(&"set:transaction_timeout".to_string()));
        assert!(p.fixes.contains(&"create_schema_public".to_string()));
        assert!(!p.warnings.iter().any(|w| w.code == "downgrade"));
    }

    #[test]
    fn downgrade_is_warned() {
        let p = plan_restore(
            Engine::Postgres,
            &archive("1.15", "15.4"),
            &tools("18.6"),
            &target("9.6.24"),
            true,
            "x",
        );
        assert!(p.warnings.iter().any(|w| w.code == "downgrade"));
        assert!(p.fixes.contains(&"sequence_as_type".to_string()));
    }

    #[test]
    fn old_pg_restore_cannot_read_new_archive() {
        let p = plan_restore(
            Engine::Postgres,
            &archive("1.16", "18.3"),
            &tools("16.2"),
            &target("16.2"),
            true,
            "x",
        );
        let b = p.blocker.expect("blocked");
        assert_eq!(b.code, "archive_too_new");
        assert_eq!(b.params["need"], "17");
    }

    #[test]
    fn missing_target_db() {
        let mut t = target("18.6");
        t.exists = false;
        let p = plan_restore(
            Engine::Postgres,
            &archive("1.16", "18.3"),
            &tools("18.6"),
            &t,
            false,
            "x",
        );
        assert_eq!(p.blocker.unwrap().code, "target_missing");
        let p = plan_restore(
            Engine::Postgres,
            &archive("1.16", "18.3"),
            &tools("18.6"),
            &t,
            true,
            "x",
        );
        assert!(p.blocker.is_none());
        assert!(p
            .warnings
            .iter()
            .any(|w| w.code == "target_will_be_created"));
    }
}
