-- =============================================================================
-- MotoTrack AI — Esquema de Vehículos y Órdenes de Trabajo (Fase 3)
-- =============================================================================
-- ⚠️  INSTRUCCIONES:
--   1. Abre pgAdmin 4 y conéctate a la base de datos "mototrack_db"
--      (clic derecho sobre mototrack_db → Query Tool).
--   2. Ejecuta este archivo UNA SOLA VEZ, ANTES de levantar el backend.
--   3. Este script NO se ejecuta automáticamente desde Node.js.
--   4. Si ya corriste schema.sql (Fase 2), ejecuta este archivo ADICIONAL;
--      no reemplaza al anterior.
-- =============================================================================

-- 1. Tabla: vehicles
--    Un vehículo se identifica unívocamente por su placa.
CREATE TABLE IF NOT EXISTS vehicles (
  id              SERIAL          PRIMARY KEY,
  placa           VARCHAR(10)     UNIQUE NOT NULL,
  brand           VARCHAR(50),
  model           VARCHAR(50),
  customer_name   VARCHAR(150)    NOT NULL,
  customer_phone  VARCHAR(20),
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- 2. Tabla: work_orders
--    TODO (Fase de Auth): convertir mechanic_name en FK a tabla de usuarios.
CREATE TABLE IF NOT EXISTS work_orders (
  id               SERIAL           PRIMARY KEY,
  vehicle_id       INTEGER          NOT NULL REFERENCES vehicles(id),
  mechanic_name    VARCHAR(100),
  status           VARCHAR(30)      NOT NULL DEFAULT 'recibido',
  entry_mileage    INTEGER          NOT NULL CHECK (entry_mileage >= 0),
  checklist_notes  TEXT,
  diagnosis_notes  TEXT,
  additional_cost  NUMERIC(10, 2),
  terminado_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- 3. Tabla: notifications
CREATE TABLE IF NOT EXISTS notifications (
  id             SERIAL       PRIMARY KEY,
  work_order_id  INTEGER      NOT NULL REFERENCES work_orders(id),
  message        TEXT         NOT NULL,
  channel        VARCHAR(20)  NOT NULL DEFAULT 'stub',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_orders_vehicle_id ON work_orders  (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_status     ON work_orders  (status);
CREATE INDEX IF NOT EXISTS idx_vehicles_placa         ON vehicles     (placa);
CREATE INDEX IF NOT EXISTS idx_notifications_wo_id    ON notifications(work_order_id);

GRANT ALL PRIVILEGES ON TABLE    vehicles      TO mototrack_user;
GRANT ALL PRIVILEGES ON TABLE    work_orders   TO mototrack_user;
GRANT ALL PRIVILEGES ON TABLE    notifications TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE vehicles_id_seq       TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE work_orders_id_seq    TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE notifications_id_seq  TO mototrack_user;
