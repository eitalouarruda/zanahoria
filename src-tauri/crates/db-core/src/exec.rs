//! Maquinaria compartida de ejecución con streaming de chunks.
//! Cada engine instancia `spawn_stream!` con su tipo de fila y su decoder.

/// Genera la tarea que ejecuta `sql` contra `pool`, decodifica filas con
/// `$decode` y emite `ExecEvent`s por un canal, con cancelación y pausa
/// (fetch_more) integradas.
macro_rules! spawn_stream {
    ($pool:expr, $sql:expr, $opts:expr, $decode:path) => {{
        use futures::StreamExt;
        use sqlx::{Column as _, Either, Row as _, TypeInfo as _};

        let pool = $pool.clone();
        let sql: String = $sql;
        let opts: $crate::driver::ExecOpts = $opts;
        let (tx, rx) =
            tokio::sync::mpsc::channel::<$crate::error::Result<$crate::driver::ExecEvent>>(16);
        let cancel = tokio_util::sync::CancellationToken::new();
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        let cancel_task = cancel.clone();
        let resume_task = resume.clone();

        tokio::spawn(async move {
            let mut stream = sqlx::raw_sql(&sql).fetch_many(&pool);
            let mut sent_columns = false;
            let mut buf: Vec<$crate::value::Row> = Vec::with_capacity(opts.chunk_size);
            let mut total_rows: u64 = 0;
            let mut rows_since_pause: usize = 0;
            let mut affected: Option<u64> = None;

            macro_rules! flush {
                () => {
                    if !buf.is_empty() {
                        let rows = std::mem::take(&mut buf);
                        if tx
                            .send(Ok($crate::driver::ExecEvent::Rows { rows }))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                };
            }

            loop {
                let item = tokio::select! {
                    _ = cancel_task.cancelled() => return,
                    item = stream.next() => item,
                };
                match item {
                    None => {
                        flush!();
                        let _ = tx
                            .send(Ok($crate::driver::ExecEvent::Done {
                                summary: $crate::driver::ExecSummary {
                                    affected,
                                    truncated: false,
                                    total_rows,
                                },
                            }))
                            .await;
                        return;
                    }
                    Some(Ok(Either::Left(result))) => {
                        affected = Some(affected.unwrap_or(0) + result.rows_affected());
                    }
                    Some(Ok(Either::Right(row))) => {
                        if !sent_columns {
                            sent_columns = true;
                            let columns = row
                                .columns()
                                .iter()
                                .map(|c| $crate::value::ColumnMeta {
                                    name: c.name().to_string(),
                                    db_type: c.type_info().name().to_string(),
                                })
                                .collect();
                            if tx
                                .send(Ok($crate::driver::ExecEvent::Columns { columns }))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                        buf.push($decode(&row));
                        total_rows += 1;
                        rows_since_pause += 1;
                        if buf.len() >= opts.chunk_size {
                            flush!();
                        }
                        if opts.max_rows > 0 && rows_since_pause >= opts.max_rows {
                            flush!();
                            if tx
                                .send(Ok($crate::driver::ExecEvent::Done {
                                    summary: $crate::driver::ExecSummary {
                                        affected,
                                        truncated: true,
                                        total_rows,
                                    },
                                }))
                                .await
                                .is_err()
                            {
                                return;
                            }
                            tokio::select! {
                                _ = cancel_task.cancelled() => return,
                                _ = resume_task.notified() => {}
                            }
                            rows_since_pause = 0;
                        }
                    }
                    Some(Err(e)) => {
                        let _ = tx.send(Err($crate::error::DbError::from(e))).await;
                        return;
                    }
                }
            }
        });

        $crate::driver::QueryStream {
            events: rx,
            cancel,
            resume,
        }
    }};
}

pub(crate) use spawn_stream;
