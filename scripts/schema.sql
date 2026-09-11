-- =============================================================================
-- MotoTrack AI — Esquema de tabla de productos
-- =============================================================================
-- ⚠️  INSTRUCCIONES:
--   1. Conéctate a pgAdmin 4 con el usuario "postgres" (o mototrack_user).
--   2. Asegúrate de estar conectado a la base de datos "mototrack_db".
--   3. Abre el Query Tool y ejecuta este archivo UNA SOLA VEZ.
--   4. Este script NO se ejecuta automáticamente desde Node.js.
-- =============================================================================

-- Conectar a la BD correcta antes de correr este script:
--   En pgAdmin: clic derecho sobre "mototrack_db" → Query Tool

CREATE TABLE IF NOT EXISTS products (
  id                   SERIAL           PRIMARY KEY,

  -- RF-08: código único para búsqueda rápida (ej. "FIL-OIL-001")
  sku                  VARCHAR(50)      UNIQUE,

  name                 VARCHAR(150)     NOT NULL,
  brand                VARCHAR(100),

  -- RF-05: array de modelos de moto compatibles (ej. '{"Honda CB125","Yamaha FZ"}')
  compatible_models    TEXT[],

  cost_price           NUMERIC(10, 2)   NOT NULL CHECK (cost_price >= 0),
  sale_price           NUMERIC(10, 2)   NOT NULL CHECK (sale_price >= 0),

  -- RF-06: stock actual y umbral de alerta de stock bajo
  stock                INTEGER          NOT NULL DEFAULT 0  CHECK (stock >= 0),
  min_stock            INTEGER          NOT NULL DEFAULT 5,

  -- RF-07: confianza del escaneo IA (0.00 – 100.00), nullable si fue registro manual
  ai_confidence        NUMERIC(5, 2),

  -- RF-01 / RF-02: 'ia' cuando se registró por escaneo, 'manual' en cualquier otro caso
  registration_method  VARCHAR(10)      NOT NULL DEFAULT 'manual',

  -- Soft-delete: NUNCA se borra un producto de la BD
  is_active            BOOLEAN          NOT NULL DEFAULT true,

  created_at           TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- Índice para búsquedas frecuentes por nombre y SKU (ILIKE aprovecha este índice con pg_trgm)
CREATE INDEX IF NOT EXISTS idx_products_name   ON products (name);
CREATE INDEX IF NOT EXISTS idx_products_sku    ON products (sku);
CREATE INDEX IF NOT EXISTS idx_products_active ON products (is_active);

-- Permisos al usuario de la aplicación
GRANT ALL PRIVILEGES ON TABLE     products TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE  products_id_seq TO mototrack_user;
