-- =============================================================================
-- MotoTrack AI — Fix: reemplazar la tabla sales de Fase 1
-- =============================================================================
-- ⚠️  Ejecutar en pgAdmin 4 conectado a "mototrack_db".
--     Borra la tabla sales del esquema antiguo (Fase 1) y la recrea con la
--     estructura correcta de Fase 4. Es seguro: la tabla vieja estaba vacía.
-- =============================================================================

-- 1. La tabla sale_items referencia sales, así que hay que eliminarla primero
DROP TABLE IF EXISTS sale_items CASCADE;
DROP TABLE IF EXISTS sales      CASCADE;

-- 2. Recrear sales con la estructura correcta de Fase 4
CREATE TABLE IF NOT EXISTS sales (
  id              SERIAL          PRIMARY KEY,
  customer_name   VARCHAR(150),
  work_order_id   INTEGER         REFERENCES work_orders(id),
  payment_method  VARCHAR(20)     NOT NULL
                  CHECK (payment_method IN ('efectivo', 'tarjeta', 'yape', 'plin')),
  subtotal        NUMERIC(10, 2),
  igv             NUMERIC(10, 2),
  total           NUMERIC(10, 2),
  status          VARCHAR(20)     NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('completed', 'voided')),
  void_reason     TEXT,
  voided_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- 3. Recrear sale_items con el CHECK XOR producto/kit
CREATE TABLE IF NOT EXISTS sale_items (
  id          SERIAL          PRIMARY KEY,
  sale_id     INTEGER         NOT NULL REFERENCES sales(id),
  product_id  INTEGER         REFERENCES products(id),
  kit_id      INTEGER         REFERENCES kits(id),
  quantity    INTEGER         NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(10, 2)  NOT NULL,
  subtotal    NUMERIC(10, 2)  NOT NULL,
  CONSTRAINT chk_sale_item_product_xor_kit
    CHECK (
      (product_id IS NOT NULL AND kit_id IS NULL)
      OR
      (product_id IS NULL AND kit_id IS NOT NULL)
    )
);

-- 4. Recrear índices
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id   ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_sales_status         ON sales      (status);
CREATE INDEX IF NOT EXISTS idx_sales_work_order_id  ON sales      (work_order_id);

-- 5. Permisos
GRANT ALL PRIVILEGES ON TABLE    sales      TO mototrack_user;
GRANT ALL PRIVILEGES ON TABLE    sale_items TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE sales_id_seq      TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE sale_items_id_seq TO mototrack_user;
