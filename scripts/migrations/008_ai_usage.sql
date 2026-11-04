-- Migración 008: Tabla para medición y observabilidad de consumo de IA por taller
-- No incluye transacciones explícitas (BEGIN/COMMIT) porque el runner las gestiona.

CREATE TABLE IF NOT EXISTS ai_usage (
    id BIGSERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    user_id INTEGER REFERENCES users(id),
    model VARCHAR(60),
    input_tokens INT,
    output_tokens INT,
    thinking_tokens INT,
    latency_ms INT,
    success BOOLEAN NOT NULL,
    error_code VARCHAR(30),
    estimated_cost_usd NUMERIC(12,6),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_company_created ON ai_usage(company_id, created_at);
