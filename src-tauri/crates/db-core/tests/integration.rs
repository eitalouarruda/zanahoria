//! Tests de integración contra las bases del docker-compose.
//! Se saltan silenciosamente si la variable de entorno correspondiente
//! no está definida (ZANAHORIA_TEST_PG, ZANAHORIA_TEST_MYSQL, ...).

use db_core::{
    analyze_query, build_mutations, ChangeKind, ConnectionConfig, DbValue, Engine, EngineHandle,
    ExecEvent, ExecOpts, PendingChange,
};
use std::collections::HashMap;

fn pg_config() -> Option<ConnectionConfig> {
    // postgres://zanahoria:zanahoria@localhost:55432/zanahoria
    std::env::var("ZANAHORIA_TEST_PG").ok()?;
    Some(ConnectionConfig {
        id: "test-pg".into(),
        name: "test".into(),
        engine: Engine::Postgres,
        host: "localhost".into(),
        port: Some(55432),
        database: "zanahoria".into(),
        user: "zanahoria".into(),
        password: Some("zanahoria".into()),
        use_tls: false,
        safe_mode: true,
        color: None,
        group: None,
    })
}

async fn collect(
    handle: &EngineHandle,
    sql: &str,
    opts: ExecOpts,
) -> (
    Vec<db_core::ColumnMeta>,
    Vec<db_core::Row>,
    db_core::ExecSummary,
) {
    let mut stream = handle.execute(sql.to_string(), opts);
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut summary = None;
    while let Some(event) = stream.events.recv().await {
        match event.expect("query failed") {
            ExecEvent::Columns { columns: c } => columns = c,
            ExecEvent::Rows { rows: r } => rows.extend(r),
            ExecEvent::Done { summary: s } => {
                let done = !s.truncated;
                summary = Some(s);
                if done {
                    break;
                }
                stream.resume.notify_one();
            }
        }
    }
    (columns, rows, summary.expect("no Done event"))
}

#[tokio::test]
async fn postgres_end_to_end() {
    let Some(cfg) = pg_config() else {
        eprintln!("skipping: ZANAHORIA_TEST_PG not set");
        return;
    };
    let handle = EngineHandle::connect(&cfg, 2).await.expect("connect");
    handle.ping().await.expect("ping");

    // Introspección
    let schema = handle.introspect("zanahoria").await.expect("introspect");
    let customers = schema
        .find_table(Some("public"), "customers")
        .expect("customers table");
    assert_eq!(customers.primary_key, vec!["id"]);
    let items = schema
        .find_table(Some("public"), "order_items")
        .expect("order_items");
    assert_eq!(items.primary_key.len(), 2, "composite pk");
    let audit = schema.find_table(Some("public"), "audit_log").unwrap();
    assert!(audit.primary_key.is_empty());

    // Query con streaming + tipos variados
    let (columns, rows, summary) = collect(
        &handle,
        "SELECT id, name, balance, metadata, is_active, created_at FROM customers ORDER BY id",
        ExecOpts::default(),
    )
    .await;
    assert_eq!(columns.len(), 6);
    assert_eq!(rows.len(), 500);
    assert_eq!(summary.total_rows, 500);
    assert!(matches!(rows[0][0], DbValue::Int(1)));
    assert!(matches!(rows[0][2], DbValue::Decimal(_)));
    assert!(matches!(rows[0][3], DbValue::Json(_)));
    assert!(matches!(rows[0][4], DbValue::Bool(_)));
    assert!(matches!(rows[0][5], DbValue::Timestamp(_)));

    // Paginación: max_rows menor que el total pausa el cursor
    let (_, rows, _) = collect(
        &handle,
        "SELECT id FROM orders ORDER BY id",
        ExecOpts {
            max_rows: 300,
            chunk_size: 100,
        },
    )
    .await;
    assert_eq!(rows.len(), 2000, "fetch_more via resume should drain all");

    // Editabilidad + mutación real (update en transacción con guard)
    let editability = analyze_query(Engine::Postgres, "SELECT * FROM customers", &schema);
    assert!(editability.editable);

    let change = PendingChange {
        target: 0,
        kind: ChangeKind::Update,
        pk: HashMap::from([("id".into(), DbValue::Int(1))]),
        values: HashMap::from([("name".into(), DbValue::Text("Renamed 1".into()))]),
        old_values: HashMap::from([("name".into(), DbValue::Text("Customer 1".into()))]),
    };
    let statements =
        build_mutations(Engine::Postgres, &editability, &[change], true).expect("build");
    let result = handle
        .apply_mutations(statements.clone(), true)
        .await
        .expect("apply");
    assert_eq!(result.affected_total, 1);

    // El guard optimista ahora falla (old value ya no coincide) y hace rollback
    let err = handle.apply_mutations(statements, true).await;
    assert!(err.is_err(), "stale guard must roll back");

    // Restaurar
    let restore = PendingChange {
        target: 0,
        kind: ChangeKind::Update,
        pk: HashMap::from([("id".into(), DbValue::Int(1))]),
        values: HashMap::from([("name".into(), DbValue::Text("Customer 1".into()))]),
        old_values: HashMap::new(),
    };
    let statements = build_mutations(Engine::Postgres, &editability, &[restore], false).unwrap();
    handle.apply_mutations(statements, true).await.unwrap();

    // Insert + delete round-trip
    let insert = PendingChange {
        target: 0,
        kind: ChangeKind::Insert,
        pk: HashMap::new(),
        values: HashMap::from([
            ("name".into(), DbValue::Text("Temp".into())),
            ("balance".into(), DbValue::Decimal("42.50".into())),
        ]),
        old_values: HashMap::new(),
    };
    let statements = build_mutations(Engine::Postgres, &editability, &[insert], false).unwrap();
    handle.apply_mutations(statements, true).await.unwrap();

    let (_, rows, _) = collect(
        &handle,
        "SELECT id FROM customers WHERE name = 'Temp'",
        ExecOpts::default(),
    )
    .await;
    assert_eq!(rows.len(), 1);
    let DbValue::Int(temp_id) = rows[0][0] else {
        panic!("expected int id")
    };

    let delete = PendingChange {
        target: 0,
        kind: ChangeKind::Delete,
        pk: HashMap::from([("id".into(), DbValue::Int(temp_id))]),
        values: HashMap::new(),
        old_values: HashMap::new(),
    };
    let statements = build_mutations(Engine::Postgres, &editability, &[delete], false).unwrap();
    let result = handle.apply_mutations(statements, true).await.unwrap();
    assert_eq!(result.affected_total, 1);

    handle.disconnect().await;
}

#[tokio::test]
async fn mysql_end_to_end() {
    if std::env::var("ZANAHORIA_TEST_MYSQL").is_err() {
        eprintln!("skipping: ZANAHORIA_TEST_MYSQL not set");
        return;
    }
    let cfg = ConnectionConfig {
        id: "test-mysql".into(),
        name: "test".into(),
        engine: Engine::Mysql,
        host: "localhost".into(),
        port: Some(33306),
        database: "zanahoria".into(),
        user: "zanahoria".into(),
        password: Some("zanahoria".into()),
        use_tls: false,
        safe_mode: false,
        color: None,
        group: None,
    };
    let handle = EngineHandle::connect(&cfg, 2).await.expect("connect");
    handle.ping().await.expect("ping");

    let schema = handle.introspect("zanahoria").await.expect("introspect");
    let customers = schema
        .find_table(None, "customers")
        .expect("customers table");
    assert_eq!(customers.primary_key, vec!["id"]);

    let (columns, rows, _) = collect(
        &handle,
        "SELECT id, name, balance FROM customers ORDER BY id",
        ExecOpts::default(),
    )
    .await;
    assert_eq!(columns.len(), 3);
    assert_eq!(rows.len(), 3);
    handle.disconnect().await;
}

#[tokio::test]
async fn redis_end_to_end() {
    if std::env::var("ZANAHORIA_TEST_REDIS").is_err() {
        eprintln!("skipping: ZANAHORIA_TEST_REDIS not set");
        return;
    }
    let cfg = ConnectionConfig {
        id: "test-redis".into(),
        name: "test".into(),
        engine: Engine::Redis,
        host: "localhost".into(),
        port: Some(63790),
        database: "0".into(),
        user: String::new(),
        password: None,
        use_tls: false,
        safe_mode: false,
        color: None,
        group: None,
    };
    let handle = EngineHandle::connect(&cfg, 1).await.expect("connect");
    handle.ping().await.expect("ping");
    assert!(!handle.capabilities().sql);

    let (_, rows, _) = collect(&handle, "SET zanahoria:test hola", ExecOpts::default()).await;
    assert_eq!(rows.len(), 1);

    let (_, rows, _) = collect(&handle, "GET zanahoria:test", ExecOpts::default()).await;
    assert!(matches!(&rows[0][1], DbValue::Text(s) if s == "hola"));
    handle.disconnect().await;
}

/// Cada tab puede apuntar a otra database de la misma conexión: el
/// PoolManager abre un pool por database sin tocar el principal.
#[tokio::test]
async fn pg_pool_por_database() {
    let Some(cfg) = pg_config() else { return };
    let pools = db_core::PoolManager::new(2);
    pools.connect(&cfg).await.unwrap();

    let current_db = |h: std::sync::Arc<EngineHandle>| async move {
        let (_, rows, _) = collect(&h, "SELECT current_database()", ExecOpts::default()).await;
        match &rows[0][0] {
            DbValue::Text(s) => s.clone(),
            other => panic!("valor inesperado: {other:?}"),
        }
    };

    let other = pools
        .get_for_database(&cfg.id, "postgres", || Ok(cfg.clone()))
        .await
        .unwrap();
    assert_eq!(current_db(other.clone()).await, "postgres");
    // El principal sigue en la database original.
    assert_eq!(
        current_db(pools.get(&cfg.id).await.unwrap()).await,
        "zanahoria"
    );
    // Segunda vez: reutiliza el mismo pool, sin reconectar.
    let again = pools
        .get_for_database(&cfg.id, "postgres", || panic!("no debe reconectar"))
        .await
        .unwrap();
    assert!(std::sync::Arc::ptr_eq(&other, &again));

    pools.disconnect(&cfg.id).await.unwrap();
    assert!(!pools.is_connected(&cfg.id).await);
}

async fn first_error(handle: &EngineHandle, sql: &str) -> db_core::DbError {
    let mut stream = handle.execute(sql.to_string(), ExecOpts::default());
    while let Some(event) = stream.events.recv().await {
        if let Err(e) = event {
            return e;
        }
    }
    panic!("expected an error for {sql:?}");
}

/// La posición del error es relativa a todo el script enviado, también
/// cuando falla un statement que no es el primero.
#[tokio::test]
async fn pg_error_position() {
    let Some(cfg) = pg_config() else { return };
    let handle = EngineHandle::connect(&cfg, 1).await.unwrap();
    let sql = "SELECT 1;\nSELECT 'ñandú',\n  (1 + );";
    let err = first_error(&handle, sql).await;
    let offset = sql.chars().position(|c| c == ')').unwrap();
    assert_eq!(
        err.position(),
        Some(&db_core::ErrorPosition::Offset { offset }),
        "{err}"
    );
    handle.disconnect().await;
}

#[tokio::test]
async fn mysql_error_position() {
    if std::env::var("ZANAHORIA_TEST_MYSQL").is_err() {
        return;
    }
    let cfg = ConnectionConfig {
        id: "test-mysql".into(),
        name: "test".into(),
        engine: Engine::Mysql,
        host: "localhost".into(),
        port: Some(33306),
        database: "zanahoria".into(),
        user: "zanahoria".into(),
        password: Some("zanahoria".into()),
        use_tls: false,
        safe_mode: false,
        color: None,
        group: None,
    };
    let handle = EngineHandle::connect(&cfg, 1).await.unwrap();
    let err = first_error(&handle, "SELECT\n  1,\n  (1 + );").await;
    assert_eq!(
        err.position(),
        Some(&db_core::ErrorPosition::Line {
            line: 3,
            statement: 0
        }),
        "{err}"
    );
    // En scripts, la línea es relativa al statement que falla (sin los
    // espacios iniciales).
    let err = first_error(&handle, "SELECT 1;\nSELECT 2;\n\nSELECT\n  (1 + );").await;
    assert_eq!(
        err.position(),
        Some(&db_core::ErrorPosition::Line {
            line: 2,
            statement: 2
        }),
        "{err}"
    );
    handle.disconnect().await;
}
