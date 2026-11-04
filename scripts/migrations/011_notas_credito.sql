-- scripts/migrations/011_notas_credito.sql
-- Tarea 12.3: Tabla credit_notes para Notas de Crédito Electrónicas (RF-23)
-- Sin BEGIN ni COMMIT (el runner migrate.js lo envuelve en su propia transacción)

CREATE TABLE IF NOT EXISTS credit_notes (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) UNIQUE,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  serie VARCHAR(4) NOT NULL,
  numero INTEGER NOT NULL,
  motivo_code VARCHAR(2) NOT NULL CHECK (motivo_code IN ('01', '02', '06')),
  motivo_descripcion VARCHAR(250) NOT NULL,
  subtotal NUMERIC(10,2) NOT NULL,
  igv NUMERIC(10,2) NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  xml_content TEXT,
  estado VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (estado IN ('pending', 'accepted', 'rejected', 'contingency')),
  cdr_response JSONB,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_credit_notes_company_serie_numero UNIQUE (company_id, serie, numero)
);

CREATE INDEX IF NOT EXISTS idx_credit_notes_company_created_at ON credit_notes (company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_notes_sale_id ON credit_notes (sale_id);
