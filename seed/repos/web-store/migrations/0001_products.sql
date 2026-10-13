CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL
);

INSERT INTO products (id, name, price_cents, stock) VALUES
  ('mug', 'Enamel mug', 1400, 12),
  ('tee', 'Cotton tee', 2500, 5),
  ('cap', 'Canvas cap', 1900, 0);
