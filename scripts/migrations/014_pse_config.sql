-- =============================================================================
-- Migración 014: Configuración de PSE ("Trae tu Facturador" / Nubefact)
-- RF-23: Emisión de boletas, facturas y notas de crédito con PSE externo o simulado.
-- NOTA: El runner de migraciones ya envuelve cada archivo en su propia transacción.
-- NO incluir BEGIN; ni COMMIT; en este archivo.
-- =============================================================================

-- 1. Configuración de PSE y series por empresa en tabla companies
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS pse_provider VARCHAR(20) NOT NULL DEFAULT 'simulado' CHECK (pse_provider IN ('simulado', 'nubefact')),
  ADD COLUMN IF NOT EXISTS pse_url TEXT,
  ADD COLUMN IF NOT EXISTS pse_token_enc TEXT,
  ADD COLUMN IF NOT EXISTS series_boleta VARCHAR(4) DEFAULT 'B001',
  ADD COLUMN IF NOT EXISTS series_factura VARCHAR(4) DEFAULT 'F001',
  ADD COLUMN IF NOT EXISTS series_nc_boleta VARCHAR(4) DEFAULT 'BC01',
  ADD COLUMN IF NOT EXISTS series_nc_factura VARCHAR(4) DEFAULT 'FC01';

-- 2. Enlaces y metadatos de respuesta del PSE en facturas y boletas (invoices)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS xml_url TEXT,
  ADD COLUMN IF NOT EXISTS hash TEXT,
  ADD COLUMN IF NOT EXISTS qr_string TEXT;

-- 3. Enlaces y metadatos de respuesta del PSE en notas de crédito (credit_notes)
ALTER TABLE credit_notes
  ADD COLUMN IF NOT EXISTS pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS xml_url TEXT,
  ADD COLUMN IF NOT EXISTS hash TEXT,
  ADD COLUMN IF NOT EXISTS qr_string TEXT;
