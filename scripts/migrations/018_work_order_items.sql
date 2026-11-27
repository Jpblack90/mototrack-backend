-- =============================================================================
-- Migración 018: Líneas de repuestos/kits/servicios dentro de OT (work_order_items)
-- Idempotente. Sin BEGIN/COMMIT sueltos (gestionados por scripts/migrate.js).
-- =============================================================================

CREATE TABLE IF NOT EXISTS work_order_items (
  id               SERIAL          PRIMARY KEY,
  company_id       INTEGER         NOT NULL REFERENCES companies(id),
  work_order_id    INTEGER         NOT NULL REFERENCES work_orders(id),
  item_type        VARCHAR(20)     NOT NULL CHECK (item_type IN ('product', 'kit', 'service')),
  product_id       INTEGER         REFERENCES products(id),
  kit_id           INTEGER         REFERENCES kits(id),
  description      TEXT,
  quantity         INTEGER         NOT NULL CHECK (quantity >= 1),
  unit_price       NUMERIC(10, 2)  NOT NULL CHECK (unit_price > 0),
  status           VARCHAR(20)     NOT NULL DEFAULT 'propuesta'
                   CHECK (status IN ('propuesta', 'aprobada', 'rechazada')),
  origin           VARCHAR(20)     NOT NULL
                   CHECK (origin IN ('recepcion', 'diagnostico', 'reparacion')),
  created_by       INTEGER         REFERENCES users(id),
  decided_by       INTEGER         REFERENCES users(id),
  decided_at       TIMESTAMPTZ,
  decision_channel VARCHAR(20)
                   CHECK (decision_channel IN ('presencial', 'whatsapp', 'telefono', 'umbral')),
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

ALTER TABLE work_order_items DROP CONSTRAINT IF EXISTS chk_work_order_item_type_consistency;

ALTER TABLE work_order_items ADD CONSTRAINT chk_work_order_item_type_consistency CHECK (
  (item_type = 'product' AND product_id IS NOT NULL AND kit_id IS NULL)
  OR
  (item_type = 'kit' AND kit_id IS NOT NULL AND product_id IS NULL)
  OR
  (
    item_type = 'service'
    AND product_id IS NULL
    AND kit_id IS NULL
    AND description IS NOT NULL
    AND length(trim(description)) BETWEEN 1 AND 200
  )
);

CREATE INDEX IF NOT EXISTS idx_wo_items_company_wo ON work_order_items (company_id, work_order_id);
CREATE INDEX IF NOT EXISTS idx_wo_items_wo_status  ON work_order_items (work_order_id, status);
