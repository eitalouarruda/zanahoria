use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime};
use db_core::{ColumnMeta, DbValue, Row};
use rust_xlsxwriter::{Format, Workbook, Worksheet, XlsxError};

use crate::error::{CmdError, CmdResult};

/// Límite de caracteres por celda que admite Excel.
const MAX_CELL_CHARS: usize = 32_767;
/// Filas por hoja que admite Excel (incluida la cabecera).
const MAX_ROWS: usize = 1_048_576;
/// Enteros por encima de esto pierden precisión en Excel (15 dígitos): van como texto.
const MAX_SAFE_NUMBER: f64 = 1e15;

struct Formats {
    header: Format,
    date: Format,
    time: Format,
    timestamp: Format,
}

/// Exporta el resultado a un .xlsx con celdas tipadas: números como números,
/// fechas como fechas de Excel y booleanos como booleanos, para poder usar
/// fórmulas sin tener que importar nada.
#[tauri::command]
pub fn save_xlsx_file(path: String, columns: Vec<ColumnMeta>, rows: Vec<Row>) -> CmdResult<()> {
    build_xlsx(&columns, &rows)
        .and_then(|mut wb| wb.save(&path))
        .map_err(|e| CmdError {
            message: format!("could not write {path}: {e}"),
        })
}

fn build_xlsx(columns: &[ColumnMeta], rows: &[Row]) -> Result<Workbook, XlsxError> {
    let formats = Formats {
        header: Format::new().set_bold(),
        date: Format::new().set_num_format("yyyy-mm-dd"),
        time: Format::new().set_num_format("hh:mm:ss"),
        timestamp: Format::new().set_num_format("yyyy-mm-dd hh:mm:ss"),
    };
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name("Result")?;

    for (c, col) in columns.iter().enumerate() {
        sheet.write_string_with_format(0, c as u16, &col.name, &formats.header)?;
    }
    let rows = &rows[..rows.len().min(MAX_ROWS - 1)];
    for (r, row) in rows.iter().enumerate() {
        for (c, value) in row.iter().enumerate() {
            write_cell(sheet, r as u32 + 1, c as u16, value, &formats)?;
        }
    }

    if !columns.is_empty() {
        sheet.set_freeze_panes(1, 0)?;
        sheet.autofilter(0, 0, rows.len() as u32, columns.len() as u16 - 1)?;
        sheet.set_autofit_max_width(60 * 7).autofit();
    }
    Ok(workbook)
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
                sheet.write_datetime_with_format(row, col, &d, &f.date)?;
            }
            None => {
                sheet.write_string(row, col, s)?;
            }
        },
        DbValue::Time(s) => match parse_time(s) {
            Some(t) => {
                sheet.write_datetime_with_format(row, col, &t, &f.time)?;
            }
            None => {
                sheet.write_string(row, col, s)?;
            }
        },
        DbValue::Timestamp(s) => match parse_timestamp(s) {
            Some(ts) => {
                sheet.write_datetime_with_format(row, col, &ts, &f.timestamp)?;
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
            parse_timestamp("2024-03-01T10:20:30+00:00").unwrap().to_string(),
            "2024-03-01 10:20:30"
        );
        assert!(parse_timestamp("2024-03-01 10:20:30").is_some());
    }

    #[test]
    fn builds_typed_workbook() {
        let columns = vec![
            ColumnMeta { name: "id".into(), db_type: "int4".into() },
            ColumnMeta { name: "at".into(), db_type: "timestamptz".into() },
            ColumnMeta { name: "amount".into(), db_type: "numeric".into() },
        ];
        let rows = vec![
            vec![
                DbValue::Int(1),
                DbValue::Timestamp("2024-03-01T10:20:30+00:00".into()),
                DbValue::Decimal("12.50".into()),
            ],
            vec![DbValue::Int(2), DbValue::Null, DbValue::Decimal("NaN".into())],
        ];
        let mut wb = build_xlsx(&columns, &rows).unwrap();
        assert!(!wb.save_to_buffer().unwrap().is_empty());
    }
}
