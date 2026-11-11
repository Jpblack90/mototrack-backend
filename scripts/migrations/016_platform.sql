-- =============================================================================
-- Migración 016: Panel de Plataforma (Super-Admin) y Auditoría Global (P1)
-- Sin BEGIN ni COMMIT (el runner scripts/migrate.js gestiona la transacción).
-- =============================================================================

-- 1. Administradores de plataforma (soporte / dueño SaaS, SIN company_id)
CREATE TABLE IF NOT EXISTS platform_admins (
  id                   SERIAL       PRIMARY KEY,
  name                 VARCHAR(150) NOT NULL,
  email                VARCHAR(150) NOT NULL UNIQUE CHECK (email = LOWER(email)),
  password_hash        VARCHAR(255) NOT NULL,
  is_active            BOOLEAN      NOT NULL DEFAULT true,
  must_change_password BOOLEAN      NOT NULL DEFAULT true,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_admins_email_lower ON platform_admins (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_platform_admins_active ON platform_admins (is_active);

-- 2. Auditoría inmutable de acciones de plataforma
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id                BIGSERIAL    PRIMARY KEY,
  platform_admin_id INTEGER      NOT NULL REFERENCES platform_admins(id),
  action            VARCHAR(50)  NOT NULL,
  target_company_id INTEGER      REFERENCES companies(id),
  target_user_id    INTEGER      REFERENCES users(id),
  details           JSONB,
  ip                VARCHAR(64),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_created ON platform_audit_logs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_company ON platform_audit_logs (target_company_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_admin   ON platform_audit_logs (platform_admin_id, created_at DESC);

-- 3. Trigger de inmutabilidad estricta (mismo patrón que audit_logs)
CREATE OR REPLACE FUNCTION fn_prevent_platform_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_logs es inmutable: no se permite UPDATE ni DELETE';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_audit_logs_immutable ON platform_audit_logs;
CREATE TRIGGER trg_platform_audit_logs_immutable
BEFORE UPDATE OR DELETE ON platform_audit_logs
FOR EACH ROW EXECUTE FUNCTION fn_prevent_platform_audit_log_mutation();
