-- Migración 009: Tabla de planes comerciales y límites de uso
-- No incluye transacciones explícitas (BEGIN/COMMIT) porque el runner las gestiona.

CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(60) NOT NULL,
    price_pen NUMERIC(10,2) NOT NULL,
    max_users INTEGER,
    max_ai_scans_month INTEGER,
    features JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Semilla del plan inicial único "mototrack"
INSERT INTO plans (code, name, price_pen, max_users, max_ai_scans_month, features)
VALUES ('mototrack', 'Plan MotoTrack', 99.00, 10, 1000, '{"whatsapp": true}'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- Agregar columna plan_id a companies
ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES plans(id);

-- Asignar el plan 'mototrack' a todas las empresas existentes
UPDATE companies
SET plan_id = (SELECT id FROM plans WHERE code = 'mototrack' LIMIT 1)
WHERE plan_id IS NULL;

-- Fijar columna como NOT NULL
ALTER TABLE companies
    ALTER COLUMN plan_id SET NOT NULL;
