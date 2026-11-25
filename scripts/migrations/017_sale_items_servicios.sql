-- =============================================================================
-- Migración 017: Líneas de servicio en sale_items y cobro único por OT (Alcance A)
-- Idempotente. Sin BEGIN/COMMIT sueltos (gestionados por scripts/migrate.js).
-- =============================================================================

-- 1. Columnas item_type y description en sale_items
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS item_type VARCHAR(20);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS description TEXT;

-- 2. Backfill idempotente de filas existentes
UPDATE sale_items
SET item_type = CASE
  WHEN product_id IS NOT NULL THEN 'product'
  WHEN kit_id IS NOT NULL THEN 'kit'
  ELSE 'service'
END
WHERE item_type IS NULL;

ALTER TABLE sale_items ALTER COLUMN item_type SET DEFAULT 'product';
ALTER TABLE sale_items ALTER COLUMN item_type SET NOT NULL;

-- 3. Reemplazar chk_sale_item_product_xor_kit de forma idempotente
ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS chk_sale_item_product_xor_kit;
ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS chk_sale_item_type_consistency;

ALTER TABLE sale_items ADD CONSTRAINT chk_sale_item_type_consistency CHECK (
  (item_type = 'product' AND product_id IS NOT NULL AND kit_id IS NULL)
  OR
  (item_type = 'kit' AND kit_id IS NOT NULL AND product_id IS NULL)
  OR
  (item_type = 'service' AND product_id IS NULL AND kit_id IS NULL AND description IS NOT NULL AND length(trim(description)) > 0)
);

-- 4. Índice único parcial: a lo sumo una venta completed por work_order_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_work_order_completed
  ON sales (work_order_id)
  WHERE work_order_id IS NOT NULL AND status = 'completed';
