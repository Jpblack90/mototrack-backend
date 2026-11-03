-- Migración 005: Seguridad y gestión de contraseñas de usuarios
-- Agrega columnas para requerir cambio de contraseña en primer ingreso y registrar el último acceso.

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
