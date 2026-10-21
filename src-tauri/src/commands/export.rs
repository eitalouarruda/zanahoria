//! Exportación de resultados a CSV / JSON / SQL / XLSX.
//!
//! `export_query` vuelve a ejecutar la consulta sin límite de filas y escribe
//! el archivo por streaming (sin cargar el resultado en memoria); siempre
//! exporta todo lo que devuelve la consulta, nunca lo filtrado en el grid.
//! `export_rows` escribe filas ya cargadas (consultas que no se pueden
//! re-ejecutar sin efectos, cuyo resultado ya está completo).

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime};
use db_core::{is_read_only, ColumnMeta, DbValue, ExecEvent, ExecOpts, Row};
use rust_xlsxwriter::{Format, Workbook, Worksheet, XlsxError};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::error::{CmdError, CmdResult};
use crate::state::{AppState, RunningQuery};

/// Límite de caracteres por celda que admite Excel.
const MAX_CELL_CHARS: usize = 32_767;
/// Filas por hoja que admite Excel (incluida la cabecera); el resto sigue en
/// hojas nuevas.
const MAX_ROWS: usize = 1_048_576;
/// Enteros por encima de esto pierden precisión en Excel (15 dígitos): van como texto.
const MAX_SAFE_NUMBER: f64 = 1e15;
/// Ancho máximo de columna (en caracteres) al ajustar el XLSX.
const MAX_COL_WIDTH: usize = 60;
/// Filas por chunk al re-ejecutar para exportar.
const EXPORT_CHUNK: usize = 1_000;
/// Frecuencia de los eventos de progreso.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
    Xlsx,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// Separador de campos del CSV (por defecto `;`).
    pub csv_separator: Option<String>,
    /// Tabla destino de los INSERT del formato SQL.
    pub table_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub rows: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    export_id: String,
    rows: u64,
}

/// Re-ejecuta `sql` (solo si es de lectura) y exporta TODAS sus filas a `path`.
/// Se cancela con `cancel_query(export_id)`; el archivo parcial se borra.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_query(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    export_id: String,
    conn_id: String,
    database: String,
    sql: String,
    format: ExportFormat,
    path: String,
    options: Option<ExportOptions>,
) -> CmdResult<ExportSummary> {
    let config = state.store.connection_for_connect(&conn_id)?;
    if !is_read_only(config.engine, &sql) {
        return Err(CmdError {
            message: "only read-only queries (SELECT) can be re-executed to export".into(),
        });
    }
    let handle = state.handle_for(&conn_id, &database).await?;
    let mut stream = handle.execute(
        sql,
        ExecOpts {
            max_rows: 0,
            chunk_size: EXPORT_CHUNK,
        },
    );
    state.queries.lock().unwrap().insert(
        export_id.clone(),
        RunningQuery {
            cancel: stream.cancel.clone(),
            resume: Arc::clone(&stream.resume),
        },
    );

    let options = options.unwrap_or_default();
    let target = path.clone();
    let id = export_id.clone();
    // La escritura (y el armado del XLSX) es bloqueante: va en su propio hilo.
    let result = tauri::async_runtime::spawn_blocking(move || {
        write_stream(&mut stream.events, format, &target, &options, |rows| {
            let _ = app.emit(
                "export:progress",
                ExportProgress {
                    export_id: id.clone(),
                    rows,
                },
            );
        })
    })
    .await
    .map_err(|e| CmdError {
        message: format!("export failed: {e}"),
    })
    .and_then(|r| r);

    state.queries.lock().unwrap().remove(&export_id);
    match result {
        Ok(rows) => Ok(ExportSummary { rows }),
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            Err(e)
        }
    }
}

/// Escribe en `path` todo lo que llega por `events` hasta el `Done` final.
/// Bloqueante: llamar desde un hilo de bloqueo.
fn write_stream(
    events: &mut tokio::sync::mpsc::Receiver<db_core::Result<ExecEvent>>,
    format: ExportFormat,
    path: &str,
    options: &ExportOptions,
    mut on_progress: impl FnMut(u64),
) -> CmdResult<u64> {
    let mut sink = new_sink(format, path, options).map_err(|e| write_error(path, e))?;
    let mut total = 0u64;
    let mut last_progress = Instant::now();
    loop {
        match events.blocking_recv() {
            Some(Ok(ExecEvent::Columns { columns })) => sink.columns(&columns),
            Some(Ok(ExecEvent::Rows { rows })) => {
                total += rows.len() as u64;
                sink.rows(&rows).map_err(|e| write_error(path, e))?;
                if last_progress.elapsed() >= PROGRESS_EVERY {
                    last_progress = Instant::now();
                    on_progress(total);
                }
            }
            // Con max_rows = 0 el único Done es el final.
            Some(Ok(ExecEvent::Done { .. })) => break,
            Some(Err(e)) => return Err(e.into()),
            // El stream se cerró sin Done: cancel_query(export_id).
            None => {
                return Err(CmdError {
                    message: "export cancelled".into(),
                })
            }
        }
    }
    sink.finish().map_err(|e| write_error(path, e))?;
    Ok(total)
}

/// Exporta filas ya cargadas en el frontend (resultado completo).
#[tauri::command]
pub async fn export_rows(
    path: String,
    format: ExportFormat,
    columns: Vec<ColumnMeta>,
    rows: Vec<Row>,
    options: Option<ExportOptions>,
) -> CmdResult<ExportSummary> {
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        write_all(format, &path, &options, &columns, &rows).map_err(|e| write_error(&path, e))?;
        Ok(ExportSummary {
            rows: rows.len() as u64,
        })
    })
    .await
    .map_err(|e| CmdError {
        message: format!("export failed: {e}"),
    })?
}

fn write_all(
    format: ExportFormat,
    path: &str,
    options: &ExportOptions,
    columns: &[ColumnMeta],
    rows: &[Row],
) -> Result<(), SinkError> {
    let mut sink = new_sink(format, path, options)?;
    if !columns.is_empty() {
        sink.columns(columns);
    }
    sink.rows(rows)?;
    sink.finish()
}

fn write_error(path: &str, e: SinkError) -> CmdError {
    CmdError {
        message: format!("could not write {path}: {e}"),
    }
}

#[derive(Debug, thiserror::Error)]
enum SinkError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Xlsx(#[from] XlsxError),
}

/// Destino de exportación que recibe el resultado por partes.
trait RowSink: Send {
    /// Llega antes de la primera fila (si la consulta no devuelve filas, nunca).
    fn columns(&mut self, columns: &[ColumnMeta]);
    fn rows(&mut self, rows: &[Row]) -> Result<(), SinkError>;
    fn finish(self: Box<Self>) -> Result<(), SinkError>;
}

fn new_sink(
    format: ExportFormat,
    path: &str,
    options: &ExportOptions,
) -> Result<Box<dyn RowSink>, SinkError> {
    if let ExportFormat::Xlsx = format {
        return Ok(Box::new(XlsxSink::new(path.to_string())?));
    }
    let out = BufWriter::new(File::create(path)?);
    Ok(match format {
        ExportFormat::Csv => Box::new(CsvSink {
            out,
            sep: options
                .csv_separator
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| ";".into()),
            header_pending: None,
        }),
        ExportFormat::Json => Box::new(JsonSink {
            out,
            columns: Vec::new(),
            first: true,
        }),
        ExportFormat::Sql => Box::new(SqlSink {
            out,
            table: options
                .table_name
                .clone()
                .unwrap_or_else(|| "exported".into()),
            cols: String::new(),
            first: true,
        }),
        ExportFormat::Xlsx => unreachable!(),
    })
}

// ---------- CSV ----------

struct CsvSink {
    out: BufWriter<File>,
    sep: String,
    /// La cabecera se escribe con la primera escritura (ver `columns`).
    header_pending: Option<String>,
}

fn csv_escape(value: &str, sep: &str) -> String {
    if value.contains(['"', '\n', '\r']) || value.contains(sep) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// Igual que `dbValueToDisplay` del frontend.
fn display(v: &DbValue) -> String {
    match v {
        DbValue::Null => "NULL".into(),
        DbValue::Bool(b) => b.to_string(),
        DbValue::Int(i) => i.to_string(),
        DbValue::Float(f) => f.to_string(),
        DbValue::Json(j) => j.to_string(),
        DbValue::Bytes(b64) => format!("<binary {} b64 chars>", b64.len()),
        DbValue::Decimal(s)
        | DbValue::Text(s)
        | DbValue::Date(s)
        | DbValue::Time(s)
        | DbValue::Timestamp(s)
        | DbValue::Uuid(s) => s.clone(),
    }
}

impl RowSink for CsvSink {
    fn columns(&mut self, columns: &[ColumnMeta]) {
        let header: Vec<String> = columns
            .iter()
            .map(|c| csv_escape(&c.name, &self.sep))
            .collect();
        self.header_pending = Some(header.join(&self.sep));
    }

    fn rows(&mut self, rows: &[Row]) -> Result<(), SinkError> {
        if let Some(header) = self.header_pending.take() {
            self.out.write_all(header.as_bytes())?;
        }
        for row in rows {
            let line: Vec<String> = row
                .iter()
                .map(|v| match v {
                    DbValue::Null => String::new(),
                    v => csv_escape(&display(v), &self.sep),
                })
                .collect();
            self.out.write_all(b"\n")?;
            self.out.write_all(line.join(&self.sep).as_bytes())?;
        }
        Ok(())
    }

    fn finish(mut self: Box<Self>) -> Result<(), SinkError> {
        if let Some(header) = self.header_pending.take() {
            self.out.write_all(header.as_bytes())?;
        }
        self.out.flush()?;
        Ok(())
    }
}

// ---------- JSON ----------

/// Array de objetos con el mismo formato que `JSON.stringify(x, null, 2)`.
struct JsonSink {
    out: BufWriter<File>,
    /// Nombres de columna ya serializados como claves JSON.
    columns: Vec<String>,
    first: bool,
}

fn json_value(v: &DbValue) -> serde_json::Value {
    use serde_json::Value;
    match v {
        DbValue::Null => Value::Null,
        DbValue::Bool(b) => Value::Bool(*b),
        DbValue::Int(i) => Value::from(*i),
        DbValue::Float(f) => serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number),
        DbValue::Json(j) => j.clone(),
        DbValue::Decimal(s)
        | DbValue::Text(s)
        | DbValue::Bytes(s)
        | DbValue::Date(s)
        | DbValue::Time(s)
        | DbValue::Timestamp(s)
        | DbValue::Uuid(s) => Value::String(s.clone()),
    }
}

impl RowSink for JsonSink {
    fn columns(&mut self, columns: &[ColumnMeta]) {
        self.columns = columns
            .iter()
            .map(|c| serde_json::to_string(&c.name).unwrap_or_default())
            .collect();
    }

    fn rows(&mut self, rows: &[Row]) -> Result<(), SinkError> {
        for row in rows {
            self.out
                .write_all(if self.first { b"[\n  {" } else { b",\n  {" })?;
            self.first = false;
            for (i, (key, value)) in self.columns.iter().zip(row).enumerate() {
                let value = serde_json::to_string_pretty(&json_value(value))
                    .unwrap_or_default()
                    .replace('\n', "\n    ");
                let comma = if i == 0 { "" } else { "," };
                write!(self.out, "{comma}\n    {key}: {value}")?;
            }
            self.out.write_all(if self.columns.is_empty() {
                b"}"
            } else {
                b"\n  }"
            })?;
        }
        Ok(())
    }

    fn finish(mut self: Box<Self>) -> Result<(), SinkError> {
        self.out
            .write_all(if self.first { b"[]" } else { b"\n]" })?;
        self.out.flush()?;
        Ok(())
    }
}

// ---------- SQL ----------

struct SqlSink {
    out: BufWriter<File>,
    table: String,
    /// Lista de columnas ya armada: `"a", "b"`.
    cols: String,
    first: bool,
}

fn sql_literal(v: &DbValue) -> String {
    match v {
        DbValue::Null => "NULL".into(),
        DbValue::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        DbValue::Int(i) => i.to_string(),
        DbValue::Float(f) => f.to_string(),
        DbValue::Decimal(s) => s.clone(),
        DbValue::Json(j) => format!("'{}'", j.to_string().replace('\'', "''")),
        DbValue::Text(s)
        | DbValue::Bytes(s)
        | DbValue::Date(s)
        | DbValue::Time(s)
        | DbValue::Timestamp(s)
        | DbValue::Uuid(s) => format!("'{}'", s.replace('\'', "''")),
    }
}

impl RowSink for SqlSink {
    fn columns(&mut self, columns: &[ColumnMeta]) {
        let cols: Vec<String> = columns.iter().map(|c| format!("\"{}\"", c.name)).collect();
        self.cols = cols.join(", ");
    }

    fn rows(&mut self, rows: &[Row]) -> Result<(), SinkError> {
        for row in rows {
            if !self.first {
                self.out.write_all(b"\n")?;
            }
            self.first = false;
            let values: Vec<String> = row.iter().map(sql_literal).collect();
            write!(
                self.out,
                "INSERT INTO \"{}\" ({}) VALUES ({});",
                self.table,
                self.cols,
                values.join(", ")
            )?;
        }
        Ok(())
    }

    fn finish(mut self: Box<Self>) -> Result<(), SinkError> {
        self.out.flush()?;
        Ok(())
    }
}

// ---------- XLSX ----------

struct Formats {
    header: Format,
    date: Format,
    time: Format,
    timestamp: Format,
}

/// XLSX con celdas tipadas (números, fechas, booleanos) para usar fórmulas
/// directamente en Excel. Hojas en modo "constant memory": las filas se
/// vuelcan a disco a medida que llegan. Si se supera el límite de filas de
/// Excel se continúa en "Result 2", "Result 3", ...
struct XlsxSink {
    path: String,
    workbook: Workbook,
    formats: Formats,
    columns: Vec<ColumnMeta>,
    /// Hoja actual (índice) y filas de datos escritas en ella.
    sheet: Option<usize>,
    sheet_rows: usize,
    /// Ancho (en caracteres) de cada columna en la hoja actual.
    widths: Vec<usize>,
}

impl XlsxSink {
    fn new(path: String) -> Result<Self, SinkError> {
        Ok(Self {
            path,
            workbook: Workbook::new(),
            formats: Formats {
                header: Format::new().set_bold(),
                date: Format::new().set_num_format("yyyy-mm-dd"),
                time: Format::new().set_num_format("hh:mm:ss"),
                timestamp: Format::new().set_num_format("yyyy-mm-dd hh:mm:ss"),
            },
            columns: Vec::new(),
            sheet: None,
            sheet_rows: 0,
            widths: Vec::new(),
        })
    }

    /// Cierra la hoja actual (si hay) y abre otra con la cabecera.
    fn new_sheet(&mut self) -> Result<(), SinkError> {
        self.close_sheet()?;
        let index = self.sheet.map_or(0, |i| i + 1);
        let sheet = self.workbook.add_worksheet_with_constant_memory()?;
        sheet.set_name(if index == 0 {
            "Result".to_string()
        } else {
            format!("Result {}", index + 1)
        })?;
        for (c, col) in self.columns.iter().enumerate() {
            sheet.write_string_with_format(0, c as u16, &col.name, &self.formats.header)?;
        }
        self.widths = self
            .columns
            .iter()
            .map(|c| c.name.chars().count())
            .collect();
        self.sheet = Some(index);
        self.sheet_rows = 0;
        Ok(())
    }

    /// Ajusta anchos, congela la cabecera y agrega el autofiltro.
    fn close_sheet(&mut self) -> Result<(), SinkError> {
        let Some(index) = self.sheet else {
            return Ok(());
        };
        if self.columns.is_empty() {
            return Ok(());
        }
        let sheet = self.workbook.worksheet_from_index(index)?;
        for (c, w) in self.widths.iter().enumerate() {
            sheet.set_column_width(c as u16, (*w).min(MAX_COL_WIDTH) as f64 + 2.0)?;
        }
        sheet.set_freeze_panes(1, 0)?;
        sheet.autofilter(0, 0, self.sheet_rows as u32, self.columns.len() as u16 - 1)?;
        Ok(())
    }
}

impl RowSink for XlsxSink {
    fn columns(&mut self, columns: &[ColumnMeta]) {
        self.columns = columns.to_vec();
    }

    fn rows(&mut self, rows: &[Row]) -> Result<(), SinkError> {
        for row in rows {
            if self.sheet.is_none() || self.sheet_rows >= MAX_ROWS - 1 {
                self.new_sheet()?;
            }
            self.sheet_rows += 1;
            let r = self.sheet_rows as u32;
            let sheet = self.workbook.worksheet_from_index(self.sheet.unwrap())?;
            for (c, value) in row.iter().enumerate() {
                write_cell(sheet, r, c as u16, value, &self.formats)?;
                if let Some(w) = self.widths.get_mut(c) {
                    *w = (*w).max(cell_width(value));
                }
            }
        }
        Ok(())
    }

    fn finish(mut self: Box<Self>) -> Result<(), SinkError> {
        if self.sheet.is_none() {
            self.new_sheet()?;
        }
        self.close_sheet()?;
        self.workbook.save(&self.path)?;
        Ok(())
    }
}

/// Ancho aproximado (en caracteres) de una celda tal como la muestra Excel.
fn cell_width(v: &DbValue) -> usize {
    match v {
        DbValue::Null => 0,
        DbValue::Date(_) => 10,
        DbValue::Time(_) => 8,
        DbValue::Timestamp(_) => 19,
        DbValue::Text(s) | DbValue::Uuid(s) | DbValue::Decimal(s) => {
            s.chars().take(MAX_COL_WIDTH).count()
        }
        v => display(v).chars().take(MAX_COL_WIDTH).count(),
    }
}

fn write_cell(
    sheet: &mut Worksheet,
    row: u32,
    col: u16,
    value: &DbValue,
    f: &Formats,
) -> Result<(), XlsxError> {
    match value {
        DbValue::Null => {}
        DbValue::Bool(b) => {
            sheet.write_boolean(row, col, *b)?;
        }
        DbValue::Int(i) if (*i as f64).abs() < MAX_SAFE_NUMBER => {
            sheet.write_number(row, col, *i as f64)?;
        }
        DbValue::Int(i) => {
            sheet.write_string(row, col, i.to_string())?;
        }
        DbValue::Float(n) if n.is_finite() => {
            sheet.write_number(row, col, *n)?;
        }
        DbValue::Decimal(s) => match s.parse::<f64>() {
            Ok(n) if n.is_finite() => {
                sheet.write_number(row, col, n)?;
            }
            _ => {
                sheet.write_string(row, col, s)?;
            }
        },
        DbValue::Date(s) => match parse_date(s) {
            Some(d) => {
                sheet.write_datetime_with_format(row, col, d, &f.date)?;
            }
            None => {
                sheet.write_string(row, col, s)?;
            }
        },
        DbValue::Time(s) => match parse_time(s) {
            Some(t) => {
                sheet.write_datetime_with_format(row, col, t, &f.time)?;
            }
            None => {
                sheet.write_string(row, col, s)?;
            }
        },
        DbValue::Timestamp(s) => match parse_timestamp(s) {
            Some(ts) => {
                sheet.write_datetime_with_format(row, col, ts, &f.timestamp)?;
            }
            None => {
                sheet.write_string(row, col, s)?;
            }
        },
        DbValue::Json(v) => {
            sheet.write_string(row, col, truncate(&v.to_string()))?;
        }
        DbValue::Float(n) => {
            sheet.write_string(row, col, n.to_string())?;
        }
        DbValue::Text(s) | DbValue::Bytes(s) | DbValue::Uuid(s) => {
            sheet.write_string(row, col, truncate(s))?;
        }
    }
    Ok(())
}

/// Excel no representa fechas anteriores a 1900 ni posteriores a 9999.
fn in_excel_range(d: NaiveDate) -> bool {
    (1900..=9999).contains(&d.year())
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .filter(|d| in_excel_range(*d))
}

fn parse_time(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s, "%H:%M:%S%.f").ok()
}

/// Los timestamps llegan en RFC 3339 (UTC); se escriben tal cual, sin zona,
/// igual que se muestran en el grid.
fn parse_timestamp(s: &str) -> Option<NaiveDateTime> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_local())
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f"))
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f"))
        .ok()
        .filter(|dt| in_excel_range(dt.date()))
}

fn truncate(s: &str) -> &str {
    match s.char_indices().nth(MAX_CELL_CHARS) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_engine_formats() {
        assert!(parse_date("2024-03-01").is_some());
        assert!(parse_date("1850-01-01").is_none());
        assert!(parse_time("13:45:00").is_some());
        assert!(parse_time("13:45:00.123456").is_some());
        assert_eq!(
            parse_timestamp("2024-03-01T10:20:30+00:00")
                .unwrap()
                .to_string(),
            "2024-03-01 10:20:30"
        );
        assert!(parse_timestamp("2024-03-01 10:20:30").is_some());
    }

    fn cols(names: &[&str]) -> Vec<ColumnMeta> {
        names
            .iter()
            .map(|n| ColumnMeta {
                name: n.to_string(),
                db_type: "text".into(),
            })
            .collect()
    }

    fn export_to_string(format: ExportFormat, columns: &[ColumnMeta], rows: &[Row]) -> String {
        let dir = std::env::temp_dir().join(format!("zanahoria-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out");
        let path = path.to_str().unwrap();
        write_all(format, path, &ExportOptions::default(), columns, rows).unwrap();
        let out = std::fs::read_to_string(path).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        out
    }

    #[test]
    fn csv_quotes_values_with_separator() {
        let rows = vec![
            vec![DbValue::Int(1), DbValue::Text("a;b".into())],
            vec![DbValue::Int(2), DbValue::Null],
        ];
        assert_eq!(
            export_to_string(ExportFormat::Csv, &cols(&["id", "name"]), &rows),
            "id;name\n1;\"a;b\"\n2;"
        );
    }

    #[test]
    fn json_matches_js_pretty_print() {
        let rows = vec![
            vec![
                DbValue::Int(1),
                DbValue::Json(serde_json::json!({"k": [1]})),
            ],
            vec![DbValue::Int(2), DbValue::Null],
        ];
        let out = export_to_string(ExportFormat::Json, &cols(&["id", "meta"]), &rows);
        let expected = serde_json::to_string_pretty(&serde_json::json!([
            {"id": 1, "meta": {"k": [1]}},
            {"id": 2, "meta": null},
        ]))
        .unwrap();
        assert_eq!(out, expected);
        assert_eq!(export_to_string(ExportFormat::Json, &[], &[]), "[]");
    }

    #[test]
    fn sql_generates_inserts() {
        let rows = vec![vec![DbValue::Int(1), DbValue::Text("O'Hara".into())]];
        assert_eq!(
            export_to_string(ExportFormat::Sql, &cols(&["id", "name"]), &rows),
            "INSERT INTO \"exported\" (\"id\", \"name\") VALUES (1, 'O''Hara');"
        );
    }

    #[test]
    fn builds_typed_workbook() {
        let columns = vec![
            ColumnMeta {
                name: "id".into(),
                db_type: "int4".into(),
            },
            ColumnMeta {
                name: "at".into(),
                db_type: "timestamptz".into(),
            },
            ColumnMeta {
                name: "amount".into(),
                db_type: "numeric".into(),
            },
        ];
        let rows = vec![
            vec![
                DbValue::Int(1),
                DbValue::Timestamp("2024-03-01T10:20:30+00:00".into()),
                DbValue::Decimal("12.50".into()),
            ],
            vec![
                DbValue::Int(2),
                DbValue::Null,
                DbValue::Decimal("NaN".into()),
            ],
        ];
        let dir = std::env::temp_dir().join(format!("zanahoria-xlsx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.xlsx");
        let path = path.to_str().unwrap();
        write_all(
            ExportFormat::Xlsx,
            path,
            &ExportOptions::default(),
            &columns,
            &rows,
        )
        .unwrap();
        assert!(std::fs::metadata(path).unwrap().len() > 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Lento (~1M filas): `cargo test -- --ignored xlsx_spills`.
    #[test]
    #[ignore]
    fn xlsx_spills_to_new_sheet() {
        let rows: Vec<Row> = (0..MAX_ROWS as i64 + 10)
            .map(|i| vec![DbValue::Int(i)])
            .collect();
        let path = std::env::temp_dir().join("zanahoria-xlsx-spill.xlsx");
        let path = path.to_str().unwrap();
        write_all(
            ExportFormat::Xlsx,
            path,
            &ExportOptions::default(),
            &cols(&["n"]),
            &rows,
        )
        .unwrap();
        eprintln!("written {path}");
    }

    /// Re-ejecución real sin límite de filas (más que el `max_rows` del grid).
    /// Requiere el Postgres del docker-compose: ZANAHORIA_TEST_PG=1.
    #[test]
    fn exports_every_row_from_postgres() {
        if std::env::var("ZANAHORIA_TEST_PG").is_err() {
            return;
        }
        let rt = tokio::runtime::Runtime::new().unwrap();
        let cfg = db_core::ConnectionConfig {
            id: "test-pg".into(),
            name: "test".into(),
            engine: db_core::Engine::Postgres,
            host: "localhost".into(),
            port: Some(55432),
            database: "zanahoria".into(),
            user: "zanahoria".into(),
            password: Some("zanahoria".into()),
            use_tls: false,
            safe_mode: true,
            color: None,
            group: None,
        };
        let handle = rt
            .block_on(db_core::EngineHandle::connect(&cfg, 1))
            .unwrap();
        let sql = "SELECT n, 'fila ' || n AS label FROM generate_series(1, 25000) n";
        assert!(is_read_only(db_core::Engine::Postgres, sql));
        let mut stream = {
            let _guard = rt.enter();
            handle.execute(
                sql.into(),
                ExecOpts {
                    max_rows: 0,
                    chunk_size: EXPORT_CHUNK,
                },
            )
        };
        let path = std::env::temp_dir().join(format!("zanahoria-pg-{}.csv", uuid::Uuid::new_v4()));
        let path = path.to_str().unwrap().to_string();
        let total = std::thread::spawn({
            let path = path.clone();
            move || {
                write_stream(
                    &mut stream.events,
                    ExportFormat::Csv,
                    &path,
                    &ExportOptions::default(),
                    |_| {},
                )
                .unwrap()
            }
        })
        .join()
        .unwrap();
        assert_eq!(total, 25_000);
        let out = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(out.lines().count(), 25_001);
        assert_eq!(out.lines().last(), Some("25000;fila 25000"));
        rt.block_on(handle.disconnect());
    }
}
