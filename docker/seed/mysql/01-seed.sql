-- Datos de prueba para MySQL/MariaDB.
CREATE TABLE customers (
    id int AUTO_INCREMENT PRIMARY KEY,
    name varchar(255) NOT NULL,
    email varchar(255) UNIQUE,
    balance decimal(12, 2) NOT NULL DEFAULT 0,
    metadata json,
    is_active tinyint(1) NOT NULL DEFAULT 1,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
    id int AUTO_INCREMENT PRIMARY KEY,
    customer_id int NOT NULL,
    total decimal(12, 2) NOT NULL,
    status varchar(32) NOT NULL DEFAULT 'pending',
    placed_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers (id)
);

CREATE TABLE order_items (
    order_id int NOT NULL,
    line_no int NOT NULL,
    product varchar(255) NOT NULL,
    qty int NOT NULL,
    unit_price decimal(10, 2) NOT NULL,
    PRIMARY KEY (order_id, line_no)
);

CREATE TABLE audit_log (
    happened_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    event varchar(255) NOT NULL
);

INSERT INTO customers (name, email)
VALUES
    ('Ana', 'ana@example.com'),
    ('Bruno', 'bruno@example.com'),
    ('Carla', 'carla@example.com');

INSERT INTO orders (customer_id, total, status)
VALUES (1, 100.50, 'paid'), (2, 20.00, 'pending'), (3, 999.99, 'shipped');

INSERT INTO order_items VALUES (1, 1, 'Widget', 2, 50.25), (2, 1, 'Gadget', 1, 20.00);

INSERT INTO audit_log (event) VALUES ('seeded');
