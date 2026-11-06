-- 012_avisos_whatsapp.sql
-- Fase 12 - Tarea 12.6: Avisos al cliente por WhatsApp (RF-15)
-- Consentimiento en vehículos y ciclo de vida de avisos en notifications.
-- NOTA: Este script no incluye transacciones sueltas (BEGIN/COMMIT).

-- 1. Consentimiento de WhatsApp en vehículos
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at TIMESTAMPTZ;

-- 2. Ciclo de vida y eventos en notificaciones
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'skipped',
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opened_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS event VARCHAR(30);

-- Nuevas inserciones tendrán status 'pending' por defecto
ALTER TABLE notifications ALTER COLUMN status SET DEFAULT 'pending';

-- Restricción check para estados permitidos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_notifications_status'
  ) THEN
    ALTER TABLE notifications ADD CONSTRAINT chk_notifications_status
      CHECK (status IN ('pending', 'opened', 'skipped'));
  END IF;
END $$;

-- Índice para consultas rápidas de avisos pendientes por empresa
CREATE INDEX IF NOT EXISTS idx_notifications_company_status ON notifications(company_id, status);
