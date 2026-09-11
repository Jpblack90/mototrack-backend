-- =============================================================================
-- MotoTrack AI — Fix: reemplazar la tabla work_orders de Fase 1
-- =============================================================================
-- ⚠️  Ejecutar en pgAdmin 4 conectado a "mototrack_db".
--     Este script borra la tabla work_orders del esquema antiguo (Fase 1)
--     y la recrea con la estructura correcta de Fase 3.
--     Es seguro porque la tabla vieja estaba vacía (solo era un esqueleto).
-- =============================================================================

-- 1. Eliminar la tabla work_orders vieja (y su secuencia asociada)
--    CASCADE elimina también cualquier índice o referencia pendiente
DROP TABLE IF EXISTS work_orders CASCADE;

-- 2. Recrear vehicles (por si no existe aún)
CREATE TABLE IF NOT EXISTS vehicles (
  id              SERIAL          PRIMARY KEY,
  placa           VARCHAR(10)     UNIQUE NOT NULL,
  brand           VARCHAR(50),
  model           VARCHAR(50),
  customer_name   VARCHAR(150)    NOT NULL,
  customer_phone  VARCHAR(20),
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- 3. Recrear work_orders con la estructura correcta de Fase 3
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

-- 4. Crear notifications (por si el DROP CASCADE la eliminó en cascada también)
DROP TABLE IF EXISTS notifications CASCADE;

CREATE TABLE IF NOT EXISTS notifications (
  id             SERIAL       PRIMARY KEY,
  work_order_id  INTEGER      NOT NULL REFERENCES work_orders(id),
  message        TEXT         NOT NULL,
  channel        VARCHAR(20)  NOT NULL DEFAULT 'stub',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 5. Índices
CREATE INDEX IF NOT EXISTS idx_work_orders_vehicle_id ON work_orders  (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_status     ON work_orders  (status);
CREATE INDEX IF NOT EXISTS idx_vehicles_placa         ON vehicles     (placa);
CREATE INDEX IF NOT EXISTS idx_notifications_wo_id    ON notifications(work_order_id);

-- 6. Permisos
GRANT ALL PRIVILEGES ON TABLE    vehicles      TO mototrack_user;
GRANT ALL PRIVILEGES ON TABLE    work_orders   TO mototrack_user;
GRANT ALL PRIVILEGES ON TABLE    notifications TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE vehicles_id_seq       TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE work_orders_id_seq    TO mototrack_user;
GRANT ALL PRIVILEGES ON SEQUENCE notifications_id_seq  TO mototrack_user;
