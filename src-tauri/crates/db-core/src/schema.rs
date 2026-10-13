use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSchema {
    /// Postgres: schemas reales. MySQL/SQLite/Redis: un solo namespace.
    pub namespaces: Vec<Namespace>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Namespace {
    pub name: String,
    pub tables: Vec<Table>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub name: String,
    pub kind: TableKind,
    pub columns: Vec<Column>,
    pub primary_key: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub db_type: String,
    pub nullable: bool,
    pub is_pk: bool,
}

impl DbSchema {
    /// Busca una tabla por nombre calificado o simple.
    pub fn find_table(&self, namespace: Option<&str>, table: &str) -> Option<&Table> {
        match namespace {
            Some(ns) => self
                .namespaces
                .iter()
                .find(|n| n.name == ns)?
                .tables
                .iter()
                .find(|t| t.name == table),
            None => self
                .namespaces
                .iter()
                .flat_map(|n| n.tables.iter())
                .find(|t| t.name == table),
        }
    }
}
