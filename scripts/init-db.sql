-- =============================================================================
-- MotoTrack AI — Script de inicialización (PASO 1 de 5)
-- =============================================================================
-- ⚠️  INSTRUCCIONES PARA INSTALACIÓN DESDE CERO:
--
--   Ejecutar los scripts EN ESTE ORDEN desde pgAdmin 4:
--
--   PASO 1 → init-db.sql          (este archivo) — crea usuario y BD
--              Conectado a: servidor postgres, usuario postgres
--
--   PASO 2 → schema.sql           — tabla products (Inventario)
--   PASO 3 → schema_workorders.sql — tablas vehicles, work_orders, notifications
--   PASO 4 → schema_sales.sql     — tablas kits, kit_items, sales, sale_items
--   PASO 5 → schema_invoicing.sql  — tabla invoices (Facturación)
--              Conectado a: mototrack_db para los pasos 2-5
--
--   Ningún script se ejecuta automáticamente desde Node.js.
-- =============================================================================

-- ── PASO 1A: Ejecutar conectado al servidor (usuario postgres) ────────────────

-- Crear usuario de la aplicación (si no existe)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mototrack_user') THEN
    CREATE USER mototrack_user WITH PASSWORD 'changeme';
  END IF;
END
$$;

-- Crear la base de datos
-- Si pgAdmin lanza error porque ya existe, ignóralo y continúa.
CREATE DATABASE mototrack_db
  OWNER      mototrack_user
  ENCODING   'UTF8'
  LC_COLLATE 'es_ES.UTF-8'
  LC_CTYPE   'es_ES.UTF-8'
  TEMPLATE   template0;

-- ── PASO 1B: Reconectar a mototrack_db y ejecutar el resto ───────────────────
-- En pgAdmin: clic derecho sobre mototrack_db → Query Tool
-- Luego ejecuta las líneas siguientes:

-- Privilegios generales
GRANT ALL PRIVILEGES ON DATABASE mototrack_db TO mototrack_user;
GRANT ALL ON SCHEMA public TO mototrack_user;

-- Permisos por defecto para objetos futuros (tablas creadas por los schemas 2-5)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO mototrack_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO mototrack_user;

-- =============================================================================
-- SIGUIENTE PASO: abrir schema.sql y ejecutarlo también en mototrack_db
-- =============================================================================
