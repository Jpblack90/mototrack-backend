-- =============================================================================
-- Migración 002: Agregar columna category e índice en tabla products
-- =============================================================================

ALTER TABLE products 
  ADD COLUMN IF NOT EXISTS category VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_products_category 
  ON products (category);
