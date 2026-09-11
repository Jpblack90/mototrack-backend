-- =============================================================================
-- MotoTrack AI — Script de inicialización de base de datos
-- =============================================================================
-- ⚠️  INSTRUCCIONES:
--   1. Conéctate a pgAdmin 4 con el usuario "postgres" (superusuario).
--   2. Abre el Query Tool (clic derecho sobre el servidor → Query Tool).
--   3. Ejecuta TODO este script UNA SOLA VEZ antes de levantar el backend.
--   4. Este script NO se ejecuta automáticamente desde Node.js.
-- =============================================================================

-- 1. Crear usuario de aplicación
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mototrack_user') THEN
    CREATE USER mototrack_user WITH PASSWORD 'changeme';
  END IF;
END
$$;

-- 2. Crear base de datos (debe ejecutarse fuera de una transacción)
-- Si pgAdmin lanza error porque la BD ya existe, puedes ignorarlo o comentar esta línea.
CREATE DATABASE mototrack_db
  OWNER      mototrack_user
  ENCODING   'UTF8'
  LC_COLLATE 'es_ES.UTF-8'
  LC_CTYPE   'es_ES.UTF-8'
  TEMPLATE   template0;

-- =============================================================================
-- Conectar a mototrack_db antes de ejecutar el resto
-- En pgAdmin: cambia la conexión a la BD "mototrack_db" y re-ejecuta desde aquí
-- =============================================================================

-- 3. Privilegios generales
GRANT ALL PRIVILEGES ON DATABASE mototrack_db TO mototrack_user;
GRANT ALL ON SCHEMA public TO mototrack_user;

-- 4. Tabla: inventory
CREATE TABLE IF NOT EXISTS inventory (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120)   NOT NULL,
  description TEXT,
  quantity    INTEGER        NOT NULL DEFAULT 0,
  unit_price  NUMERIC(10, 2) NOT NULL DEFAULT 0,
  category    VARCHAR(80),
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- 5. Tabla: work_orders
CREATE TABLE IF NOT EXISTS work_orders (
  id               SERIAL PRIMARY KEY,
  customer_name    VARCHAR(120)  NOT NULL,
  motorcycle_plate VARCHAR(20),
  description      TEXT,
  status           VARCHAR(30)   NOT NULL DEFAULT 'pending',
    -- valores posibles: pending | in_progress | completed | cancelled
  assigned_to      VARCHAR(80),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 6. Tabla: sales
CREATE TABLE IF NOT EXISTS sales (
  id              SERIAL PRIMARY KEY,
  customer_name   VARCHAR(120),
  total_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  payment_method  VARCHAR(30),
    -- valores posibles: cash | card | transfer
  items           JSONB          NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- 7. Tabla: invoices (facturación SUNAT)
CREATE TABLE IF NOT EXISTS invoices (
  id              SERIAL PRIMARY KEY,
  sale_id         INTEGER        REFERENCES sales(id) ON DELETE SET NULL,
  customer_ruc    VARCHAR(11),
  customer_name   VARCHAR(120),
  serie           VARCHAR(4)     NOT NULL,   -- ej. F001
  correlativo     VARCHAR(8)     NOT NULL,   -- ej. 00000001
  total_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  igv             NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status          VARCHAR(20)    NOT NULL DEFAULT 'draft',
    -- valores posibles: draft | sent | accepted | rejected | voided
  sunat_response  JSONB          DEFAULT '{}',
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- 8. Permisos a nivel de tabla para el usuario de la app
GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO mototrack_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO mototrack_user;

-- Asegurar que futuros objetos también tengan permisos
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES    TO mototrack_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO mototrack_user;
