-- Migración 004: IGV histórico por venta
-- Permite que cada venta guarde la tasa de IGV aplicada al momento de su creación.

-- 1. Agregar columna igv_rate si no existe
ALTER TABLE sales ADD COLUMN IF NOT EXISTS igv_rate NUMERIC(4,3);

-- 2. Asignar tasa estándar histórica (18%) a todas las ventas existentes que tengan NULL
UPDATE sales SET igv_rate = 0.18 WHERE igv_rate IS NULL;

-- 3. Establecer NOT NULL para garantizar que todas las ventas registren su tasa
ALTER TABLE sales ALTER COLUMN igv_rate SET NOT NULL;
