-- Migración 010: Pagos mixtos (RF-24)
-- No incluye transacciones explícitas (BEGIN/COMMIT) porque el runner las gestiona.

-- 1. Tabla de pagos por venta
CREATE TABLE IF NOT EXISTS sale_payments (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    method VARCHAR(20) NOT NULL CHECK (method IN ('efectivo', 'tarjeta', 'yape', 'plin')),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    reference VARCHAR(60),
    cash_received NUMERIC(10,2),
    change_given NUMERIC(10,2),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Índices solicitados
CREATE INDEX IF NOT EXISTS idx_sale_payments_company_sale
    ON sale_payments(company_id, sale_id);

CREATE INDEX IF NOT EXISTS idx_sale_payments_company_method
    ON sale_payments(company_id, method);

-- 2. Actualizar el constraint de sales.payment_method para admitir 'mixto'
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check
    CHECK (payment_method IN ('efectivo', 'tarjeta', 'yape', 'plin', 'mixto'));

-- 3. Backfill histórico idempotente:
-- Por cada venta existente sin registros en sale_payments, se inserta una fila
-- con su payment_method original y amount = total.
INSERT INTO sale_payments (company_id, sale_id, method, amount, created_at)
SELECT s.company_id, s.id, s.payment_method, s.total, s.created_at
FROM sales s
WHERE NOT EXISTS (
    SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id
);
