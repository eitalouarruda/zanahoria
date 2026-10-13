-- Datos de prueba para desarrollo y tests de integración de db-core.
CREATE TABLE customers (
    id serial PRIMARY KEY,
    name text NOT NULL,
    email text UNIQUE,
    balance numeric(12, 2) NOT NULL DEFAULT 0,
    metadata jsonb,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers (id),
    total numeric(12, 2) NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    placed_at timestamptz NOT NULL DEFAULT now()
);

-- PK compuesta
CREATE TABLE order_items (
    order_id integer NOT NULL REFERENCES orders (id),
    line_no integer NOT NULL,
    product text NOT NULL,
    qty integer NOT NULL,
    unit_price numeric(10, 2) NOT NULL,
    PRIMARY KEY (order_id, line_no)
);

-- Sin PK (no editable en el grid)
CREATE TABLE audit_log (
    happened_at timestamptz NOT NULL DEFAULT now(),
    event text NOT NULL
);

INSERT INTO customers (name, email, balance, metadata)
SELECT
    'Customer ' || i,
    'customer' || i || '@example.com',
    (random() * 1000)::numeric(12, 2),
    jsonb_build_object('tier', CASE WHEN i % 3 = 0 THEN 'gold' ELSE 'basic' END)
FROM generate_series(1, 500) AS i;

INSERT INTO orders (customer_id, total, status)
SELECT
    (i % 500) + 1,
    (random() * 500)::numeric(12, 2),
    (ARRAY['pending', 'paid', 'shipped', 'cancelled'])[1 + i % 4]
FROM generate_series(1, 2000) AS i;

INSERT INTO order_items (order_id, line_no, product, qty, unit_price)
SELECT
    (i % 2000) + 1,
    (i / 2000) + 1,
    'Product ' || (i % 50),
    1 + i % 5,
    (random() * 100)::numeric(10, 2)
FROM generate_series(0, 5999) AS i;

INSERT INTO audit_log (event)
SELECT 'event ' || i FROM generate_series(1, 100) AS i;
