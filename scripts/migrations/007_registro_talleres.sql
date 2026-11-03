-- Migración 007: Campos para registro y periodo de prueba de talleres (onboarding)

ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
