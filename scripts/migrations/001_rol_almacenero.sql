-- =============================================================================
-- Migración 001: Agregar rol 'almacenero' al constraint CHECK de la tabla users
-- =============================================================================

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check 
  CHECK (role IN ('admin', 'cajero', 'almacenero', 'mecanico'));
