-- =============================================================================
-- Migración 003: Arquitectura Multi-tenant en el Backend (Sistema/)
-- =============================================================================

-- 1. Tabla companies
CREATE TABLE IF NOT EXISTS companies (
  id                  SERIAL PRIMARY KEY,
  ruc                 VARCHAR(11) UNIQUE,
  razon_social        VARCHAR(200) NOT NULL,
  nombre_comercial    VARCHAR(150),
  direccion           TEXT,
  telefono            VARCHAR(20),
  email               VARCHAR(150),
  logo_data           TEXT,
  igv_rate            NUMERIC(4,3) NOT NULL DEFAULT 0.18,
  approval_threshold  NUMERIC(10,2) NOT NULL DEFAULT 100,
  not_picked_up_days  INTEGER NOT NULL DEFAULT 15,
  status              VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','suspended')),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Inserta la empresa inicial "Taller Principal" si la tabla está vacía
INSERT INTO companies (razon_social, nombre_comercial, status)
SELECT 'Taller Principal', 'Taller Principal', 'active'
WHERE NOT EXISTS (SELECT 1 FROM companies);

-- 3. company_id en users, products, kits, sales, vehicles, work_orders, invoices, notifications

-- 3.1 users
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE users SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1) WHERE company_id IS NULL;
ALTER TABLE users ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_company_id_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);

-- 3.2 products
ALTER TABLE products ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE products SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1) WHERE company_id IS NULL;
ALTER TABLE products ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_company_id_fkey') THEN
    ALTER TABLE products ADD CONSTRAINT products_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_products_company_id ON products(company_id);

-- 3.3 kits
ALTER TABLE kits ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE kits SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1) WHERE company_id IS NULL;
ALTER TABLE kits ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kits_company_id_fkey') THEN
    ALTER TABLE kits ADD CONSTRAINT kits_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_kits_company_id ON kits(company_id);

-- 3.4 sales
ALTER TABLE sales ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE sales SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1) WHERE company_id IS NULL;
ALTER TABLE sales ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_company_id_fkey') THEN
    ALTER TABLE sales ADD CONSTRAINT sales_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_sales_company_id ON sales(company_id);

-- 3.5 vehicles
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE vehicles SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1) WHERE company_id IS NULL;
ALTER TABLE vehicles ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_company_id_fkey') THEN
    ALTER TABLE vehicles ADD CONSTRAINT vehicles_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_vehicles_company_id ON vehicles(company_id);

-- 3.6 work_orders
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE work_orders SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1) WHERE company_id IS NULL;
ALTER TABLE work_orders ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_company_id_fkey') THEN
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_work_orders_company_id ON work_orders(company_id);

-- 3.7 invoices
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE invoices SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1) WHERE company_id IS NULL;
ALTER TABLE invoices ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_company_id_fkey') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON invoices(company_id);

-- 3.8 notifications
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE notifications SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1) WHERE company_id IS NULL;
ALTER TABLE notifications ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_company_id_fkey') THEN
    ALTER TABLE notifications ADD CONSTRAINT notifications_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);

-- 4. Unicidad por empresa
-- 4.1 products: reemplaza UNIQUE(sku) por UNIQUE(company_id, sku)
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sku_key;
DROP INDEX IF EXISTS idx_products_sku;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_company_sku_key') THEN
    ALTER TABLE products ADD CONSTRAINT products_company_sku_key UNIQUE (company_id, sku);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_products_company_sku ON products(company_id, sku);

-- 4.2 vehicles: reemplaza UNIQUE(placa) por UNIQUE(company_id, placa)
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_placa_key;
DROP INDEX IF EXISTS idx_vehicles_placa;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_company_placa_key') THEN
    ALTER TABLE vehicles ADD CONSTRAINT vehicles_company_placa_key UNIQUE (company_id, placa);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_vehicles_company_placa ON vehicles(company_id, placa);

-- 5. Correlativos por empresa (invoice_series)
CREATE TABLE IF NOT EXISTS invoice_series (
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  serie       VARCHAR(4) NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, serie)
);

-- Quitar DEFAULT de numero en invoices (ya no se usa la secuencia global invoices_numero_seq)
ALTER TABLE invoices ALTER COLUMN numero DROP DEFAULT;

-- Inicializar last_number con el máximo actual por serie de cada empresa
INSERT INTO invoice_series (company_id, serie, last_number)
SELECT
  i.company_id,
  i.serie,
  COALESCE(MAX(i.numero), 0)
FROM invoices i
GROUP BY i.company_id, i.serie
ON CONFLICT (company_id, serie) DO UPDATE
  SET last_number = GREATEST(invoice_series.last_number, EXCLUDED.last_number);

-- Unicidad compuesta en invoices (company_id, serie, numero)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_company_serie_numero_key') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_company_serie_numero_key UNIQUE (company_id, serie, numero);
  END IF;
END $$;
