-- Migración 015: Suscripciones manuales, control de vencimiento y pagos
-- El runner de migraciones ya gestiona la transacción global (sin BEGIN/COMMIT).

-- 1. Agregar columna paid_until a la tabla companies
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS paid_until DATE;

-- 2. Crear tabla subscription_payments para registrar pagos manuales (Yape, Plin, Transferencia, Efectivo)
CREATE TABLE IF NOT EXISTS subscription_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  method VARCHAR(20) NOT NULL CHECK (method IN ('yape', 'plin', 'transferencia', 'efectivo')),
  reference VARCHAR(60),
  months INTEGER NOT NULL CHECK (months BETWEEN 1 AND 12),
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Índice para acelerar consultas de historial de pagos por empresa
CREATE INDEX IF NOT EXISTS idx_subscription_payments_company
  ON subscription_payments(company_id, id DESC);
