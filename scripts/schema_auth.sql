-- =============================================================================
-- MotoTrack AI — Esquema de Autenticación y Roles (Fase 6)
-- =============================================================================
-- ⚠️  INSTRUCCIONES:
--   1. Abre pgAdmin 4 conectado a "mototrack_db" (Query Tool).
--   2. Ejecuta este archivo UNA SOLA VEZ, ANTES de correr npm run seed:admin.
--   3. Este script NO se ejecuta automáticamente desde Node.js.
--   4. Requiere que los 4 schemas anteriores ya hayan sido ejecutados.
-- =============================================================================

-- 1. Tabla de usuarios del sistema
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL           PRIMARY KEY,
  name           VARCHAR(150)     NOT NULL,
  email          VARCHAR(150)     UNIQUE NOT NULL,
  password_hash  VARCHAR(255)     NOT NULL,
  role           VARCHAR(20)      NOT NULL
                 CHECK (role IN ('admin', 'cajero', 'mecanico')),
  is_active      BOOLEAN          NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email  ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users (role);

-- 2. Vincular órdenes de trabajo a un usuario mecánico real
--    La columna mechanic_name queda intacta (no se borra, no se renombra).
--    mechanic_id es el campo canónico desde esta fase en adelante.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS mechanic_id INTEGER REFERENCES users(id);

-- 3. Auditoría de márgenes negativos forzados
--    Registra qué Administrador aprobó la operación (cierra el hueco de Fase 2).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS force_approved_by INTEGER REFERENCES users(id);

-- Permisos
GRANT ALL PRIVILEGES ON TABLE    users         TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE users_id_seq  TO mototrack_user;
