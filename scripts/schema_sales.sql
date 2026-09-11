-- =============================================================================
-- MotoTrack AI — Esquema de Ventas y Kits (Fase 4)
-- =============================================================================
-- ⚠️  INSTRUCCIONES:
--   1. Abre pgAdmin 4 y conéctate a la base de datos "mototrack_db"
--      (clic derecho sobre mototrack_db → Query Tool).
--   2. Ejecuta este archivo UNA SOLA VEZ, ANTES de levantar el backend.
--   3. Este script NO se ejecuta automáticamente desde Node.js.
--   4. Requiere que scripts/schema.sql (Fase 2) ya haya sido ejecutado,
--      ya que sale_items referencia la tabla "products".
--   5. Requiere que scripts/fix_workorders_schema.sql (Fase 3) ya haya
--      sido ejecutado, ya que sales referencia "work_orders".
-- =============================================================================

-- 1. Tabla: kits
--    Un kit agrupa varios productos para venderlos como unidad.
CREATE TABLE IF NOT EXISTS kits (
  id          SERIAL           PRIMARY KEY,
  name        VARCHAR(150)     NOT NULL,
  description TEXT,
  kit_price   NUMERIC(10, 2)   NOT NULL CHECK (kit_price >= 0),
  is_active   BOOLEAN          NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- 2. Tabla: kit_items
--    Define qué productos y en qué cantidad componen cada kit.
CREATE TABLE IF NOT EXISTS kit_items (
  id          SERIAL   PRIMARY KEY,
  kit_id      INTEGER  NOT NULL REFERENCES kits(id),
  product_id  INTEGER  NOT NULL REFERENCES products(id),
  quantity    INTEGER  NOT NULL CHECK (quantity > 0)
);

-- 3. Tabla: sales
--    Registro de cada venta (POS). Puede estar asociada a una OT o ser
--    una venta de mostrador sin cliente registrado.
CREATE TABLE IF NOT EXISTS sales (
  id              SERIAL          PRIMARY KEY,

  -- Nullable: venta de mostrador sin cliente registrado
  customer_name   VARCHAR(150),

  -- Nullable: solo si la venta proviene de una reparación
  work_order_id   INTEGER         REFERENCES work_orders(id),

  payment_method  VARCHAR(20)     NOT NULL
                  CHECK (payment_method IN ('efectivo', 'tarjeta', 'yape', 'plin')),

  subtotal        NUMERIC(10, 2),
  igv             NUMERIC(10, 2),
  total           NUMERIC(10, 2),

  status          VARCHAR(20)     NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('completed', 'voided')),

  -- Anulación
  void_reason     TEXT,
  voided_at       TIMESTAMPTZ,

  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- 4. Tabla: sale_items
--    Líneas de detalle de cada venta.
--    Una línea corresponde a UN producto directo O a UN kit, nunca ambos.
CREATE TABLE IF NOT EXISTS sale_items (
  id          SERIAL          PRIMARY KEY,
  sale_id     INTEGER         NOT NULL REFERENCES sales(id),

  -- Exactamente uno de los dos debe estar presente (validado por el CHECK al final)
  product_id  INTEGER         REFERENCES products(id),
  kit_id      INTEGER         REFERENCES kits(id),

  quantity    INTEGER         NOT NULL CHECK (quantity > 0),

  -- Precio congelado en el momento de la venta.
  -- NUNCA se recalcula si el precio del producto cambia después.
  unit_price  NUMERIC(10, 2)  NOT NULL,

  subtotal    NUMERIC(10, 2)  NOT NULL,

  -- Garantiza que la línea tenga producto XOR kit, nunca ambos ni ninguno
  CONSTRAINT chk_sale_item_product_xor_kit
    CHECK (
      (product_id IS NOT NULL AND kit_id IS NULL)
      OR
      (product_id IS NULL AND kit_id IS NOT NULL)
    )
);

-- Índices para las consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_kit_items_kit_id      ON kit_items  (kit_id);
CREATE INDEX IF NOT EXISTS idx_kit_items_product_id  ON kit_items  (product_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id    ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_sales_status          ON sales      (status);
CREATE INDEX IF NOT EXISTS idx_sales_work_order_id   ON sales      (work_order_id);

-- Permisos al usuario de la aplicación
GRANT ALL PRIVILEGES ON TABLE    kits       TO mototrack_user;
GRANT ALL PRIVILEGES ON TABLE    kit_items  TO mototrack_user;
GRANT ALL PRIVILEGES ON TABLE    sales      TO mototrack_user;
GRANT ALL PRIVILEGES ON TABLE    sale_items TO mototrack_user;

GRANT ALL PRIVILEGES ON SEQUENCE kits_id_seq       TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE kit_items_id_seq  TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE sales_id_seq      TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE sale_items_id_seq TO mototrack_user;
