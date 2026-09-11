-- =============================================================================
-- MotoTrack AI — Esquema de Facturación Electrónica (Fase 5)
-- =============================================================================
-- ⚠️  INSTRUCCIONES:
--   1. Abre pgAdmin 4 y conéctate a la base de datos "mototrack_db"
--      (clic derecho sobre mototrack_db → Query Tool).
--   2. Ejecuta este archivo UNA SOLA VEZ, ANTES de levantar el backend.
--   3. Este script NO se ejecuta automáticamente desde Node.js.
--   4. Requiere que schema_sales.sql (Fase 4) ya haya sido ejecutado,
--      ya que invoices referencia la tabla "sales".
-- =============================================================================

-- Tabla: invoices
--   Una venta tiene como máximo UN comprobante (UNIQUE en sale_id).
--   El correlativo "numero" es un SERIAL propio independiente del id
--   para respetar la numeración correlativa por serie.
CREATE TABLE IF NOT EXISTS invoices (
  id                       SERIAL          PRIMARY KEY,

  -- RF-29: UNIQUE garantiza idempotencia a nivel de BD
  sale_id                  INTEGER         NOT NULL UNIQUE REFERENCES sales(id),

  comprobante_type         VARCHAR(10)     NOT NULL
                           CHECK (comprobante_type IN ('boleta', 'factura')),

  -- Serie del comprobante: B001 para boletas, F001 para facturas (por convención)
  serie                    VARCHAR(4)      NOT NULL DEFAULT 'B001',

  -- Correlativo propio; SERIAL garantiza que nunca se repite ni deja huecos en BD
  numero                   SERIAL,

  -- Datos del receptor (nullable para boletas de mostrador)
  customer_document_type   VARCHAR(10),   -- 'DNI' o 'RUC'
  customer_document_number VARCHAR(15),

  -- XML simplificado generado por el backend (NO es UBL 2.1 completo)
  xml_content              TEXT,

  -- Estado del comprobante ante el PSE/SUNAT
  estado                   VARCHAR(20)     NOT NULL DEFAULT 'pending'
                           CHECK (estado IN ('pending', 'accepted', 'rejected', 'contingency')),

  -- RF-28: contingencia — comprobante emitido pero PSE no disponible temporalmente
  is_contingency           BOOLEAN         NOT NULL DEFAULT false,

  -- Respuesta simulada (o real en el futuro) del PSE
  cdr_response             JSONB,

  created_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Índices para las consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_invoices_sale_id     ON invoices (sale_id);
CREATE INDEX IF NOT EXISTS idx_invoices_estado      ON invoices (estado);
CREATE INDEX IF NOT EXISTS idx_invoices_serie       ON invoices (serie);

-- Permisos al usuario de la aplicación
GRANT ALL PRIVILEGES ON TABLE    invoices            TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE invoices_id_seq     TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE invoices_numero_seq TO mototrack_user;
