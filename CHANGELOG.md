# Changelog
Todos los cambios notables de este proyecto se documentan en este archivo.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
Cada entrada indica el integrante responsable entre paréntesis.

## [Unreleased]
### Changed (Fase 13 - Tarea 13.0b)
- Ajustes de compatibilidad, auditoría, seeds y pruebas del backend:
  - Migración `scripts/migrations/013_unaccent.sql`: habilitación de la extensión PostgreSQL `unaccent` para ignorar acentos y diacríticos en comparaciones de texto (Jean Pool)
  - Normalización de modelos en SQL y JS (RF-08, RF-20, RF-21):
    - `src/shared/utils/modelNormalizer.js`: actualización de `normalizeModel(str)` descomponiendo y limpiando marcas diacríticas (`normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')`), garantizando que "Ténéré" produzca "tenere" (Jean Pool)
    - `src/modules/inventory/inventory.service.js`: filtro `compatible_with` en `getAll` alineado con `regexp_replace(lower(unaccent(m)), '[^a-z0-9]', '', 'g') = regexp_replace(lower(unaccent($N)), '[^a-z0-9]', '', 'g')` (Jean Pool)
    - Adición de caso de prueba en `scripts/tests/verify-12-4.js` (`test:stock`) validando que un producto con `"Yamaha Ténéré 700"` se localiza con `compatible_with="yamaha tenere 700"` (Jean Pool)
  - RUC válidos en seeds de prueba:
    - `src/modules/company/company.service.js`: exportación de helper `generateSunatRuc(base10)` bajo el algoritmo oficial Módulo 11 de SUNAT (Jean Pool)
    - `scripts/tests/seed-test-company.js`: actualización de RUCs de prueba a valores conformes con Módulo 11 (`20999999914` para Taller A y `20999999922` para Taller B) y actualización de las empresas de prueba existentes en base de datos (Jean Pool)
  - Prueba de rollback real en auditoría (`scripts/tests/verify-11-4.js`):
    - `src/modules/inventory/inventory.controller.js` y `inventory.service.js`: test hook de desarrollo (`X-Force-Audit-Fail: 1` / `FORCE_AUDIT_FAIL=1`) que detona un error forzado tras `logAudit()` y antes de `COMMIT` exclusivamente cuando `NODE_ENV !== 'production'` (Jean Pool)
    - `verify-11-4.js` (Caso 3): verificación de rollback atómico comprobando que ni el cambio de datos del producto ni el registro en `audit_logs` persisten en base de datos (Jean Pool)
  - Ejecutor general de pruebas `npm run test:all`:
    - `src/shared/middlewares/rateLimiter.js`: migración de limitadores a instancias `MemoryStore` dedicadas y exportación de `resetAllRateLimiters()` (Jean Pool)
    - `src/modules/auth/auth.routes.js`: endpoint de desarrollo `POST /api/auth/reset-rate-limit` habilitado cuando `NODE_ENV !== 'production'` para reiniciar contadores de rate limit (Jean Pool)
    - `scripts/tests/run-all-tests.js`: script que ejecuta en orden las 12 suites (`isolation`, `users`, `audit`, `onboarding`, `ai`, `plans`, `payments`, `credit-notes`, `stock`, `pickup`, `whatsapp`, `company`), resetea los rate limits entre suites (evitando que `test:onboarding` bloquee las siguientes) y muestra un resumen final por suite con salida de código 0 o 1 (Jean Pool)
### Added (Fase 12 - Tarea 12.6)
- Avisos al cliente por WhatsApp Fase 1 (RF-15 / Enlaces wa.me sin costo):
  - Migración `scripts/migrations/012_avisos_whatsapp.sql`:
    - Adición de `whatsapp_opt_in` (boolean, default false) y `whatsapp_opt_in_at` (timestamptz) a tabla `vehicles` para consentimiento de datos personales (Ley N° 29733) (Jean Pool)
    - Ampliación de tabla `notifications` con columnas `status` (`'pending'|'opened'|'skipped'`, default 'pending'), `opened_at`, `opened_by` (FK users) y `event` (`VARCHAR(30)`), inicializando filas preexistentes en `'skipped'` (Jean Pool)
  - Helper `src/shared/utils/phonePE.js` con función `normalizePhonePE(raw)` para celulares peruanos (9 dígitos con 9 o 11 dígitos con 519 a formato internacional `519XXXXXXXX`; fijos u otros retornan `null`) (Jean Pool)
  - Plantillas oficiales de avisos en `src/modules/workorders/whatsappTemplates.js` para los eventos `recibido`, `pendiente_aprobacion`, `terminado` y `no_recogido`, omitiendo campos no disponibles sin llaves vacías ni datos ficticios (Jean Pool)
  - Generación de avisos en `workorders.service.js`:
    - `createWorkOrder` y `findOrCreateVehicle`: validan que el celular sea válido si `whatsapp_opt_in = true` (422 si no) y registran fecha de consentimiento; emite aviso `recibido` con `status = 'pending'` (Jean Pool)
    - `updateStatus`: genera avisos pendientes para `pendiente_aprobacion` y `terminado` solo si el cliente dio su consentimiento; estados intermedios sin plantilla no generan avisos (Jean Pool)
    - `markNotPickedUp` y `markOverdueNotPickedUp` (Job): generan avisos pendientes con evento `no_recogido` para vehículos con consentimiento (Jean Pool)
  - Módulo `src/modules/notifications/` con control RBAC para roles `admin` y `cajero` (rol `mecanico` recibe 403 Forbidden):
    - `GET /api/notifications/pending`: avisos pendientes de la empresa con datos del vehículo y cliente (Jean Pool)
    - `GET /api/notifications/:id/whatsapp-link`: URL codificada `https://wa.me/51XXXXXXXXX?text=...` (422 si no cuenta con consentimiento) (Jean Pool)
    - `PATCH /api/notifications/:id/opened`: marcado idempotente registrando fecha y usuario que abrió WhatsApp (Jean Pool)
    - `PATCH /api/notifications/:id/skip`: descarte cuando el taller avisó por otro medio (Jean Pool)
  - Endpoint `GET /api/workorders/:id/notifications`: historial de avisos de una OT para `admin` y `cajero` (Jean Pool)
  - Caso 21 en `scripts/tests/test-isolation.js` validando el aislamiento multi-tenant en todas las rutas de notificaciones (Jean Pool)
  - Suite de pruebas de integración `scripts/tests/verify-12-6.js` (`npm run test:whatsapp`) con 54 pruebas automatizadas (Jean Pool)
  - Documentación de Fase 1 (wa.me) y roadmap de Fase 2 (Meta Cloud API en Fase 13) en `README.md` (Jean Pool)

### Added (Fase 12 - Tarea 12.5)
- Actualización de máquina de estados en `VALID_TRANSITIONS` de `src/modules/workorders/workorders.service.js`: adición de la transición `no_recogido → ['entregado']` permitiendo la entrega normal de motocicletas incluso si el cliente acude fuera del plazo de gracia (Jean Pool)
- Función de servicio `markOverdueNotPickedUp()` en `workorders.service.js`:
  - Operación idempotente y atómica en una sola transacción (`BEGIN / COMMIT / ROLLBACK`), segura para ejecuciones concurrentes en múltiples réplicas (Jean Pool)
  - `UPDATE work_orders` basado en `c.not_picked_up_days` de empresas activas con cálculo de `dias_esperando` (`FLOOR(EXTRACT(EPOCH FROM (NOW() - wo.terminado_at)) / 86400)::int`) (Jean Pool)
  - Inserción en `audit_logs` con `action = 'auto_not_picked_up'`, `user_id = NULL` y registro de estados y días de espera (Jean Pool)
  - Inserción de notificación al taller en `notifications` con mensaje `"Moto {placa} lleva {N} días terminada sin ser recogida"` (Jean Pool)
  - Retorna `{ updated, by_company }` (Jean Pool)
- Módulo `src/modules/jobs/` con tres modalidades de disparo (RF-17):
  - Temporizador interno periódico `startNotPickedUpScheduler` (`src/modules/jobs/notPickedUp.scheduler.js`) configurable mediante `JOB_NOT_PICKED_UP_MINUTES` (por defecto 60 min; `0` desactiva), ejecutado al arrancar en `server.js` y resiliente ante excepciones con prefijo `[JOB]` sin tumbar el proceso (Jean Pool)
  - Endpoint HTTP externo `POST /api/jobs/not-picked-up` (`src/modules/jobs/jobs.controller.js` y `jobs.routes.js`) para Cloud Scheduler en Cloud Run, protegido mediante cabecera `X-Job-Token` validada en tiempo constante (`crypto.timingSafeEqual`) contra `process.env.JOBS_TOKEN` (404 si no está configurada, 401 si falta o es inválida, 200 al procesar) (Jean Pool)
  - Script manual ejecutable vía terminal `npm run job:not-picked-up` (`scripts/jobs/run-not-picked-up.js`) (Jean Pool)
- Endpoint `GET /api/workorders/pickup-alerts` (`getPickupAlerts` en `workorders.service.js` y `workorders.controller.js`):
  - Restringido a roles `admin` y `cajero` (rol `mecanico` responde 403 Forbidden) (Jean Pool)
  - Retorna `{ not_picked_up: [...], due_soon: [...] }` donde `due_soon` son las órdenes terminadas a las que les faltan 2 días o menos para vencer (`dias_esperando >= not_picked_up_days - 2`), con `id, placa, cliente, telefono, terminado_at, dias_esperando` ordenados por urgencia (Jean Pool)
- Caso 20 en `scripts/tests/test-isolation.js` validando el aislamiento multi-tenant en `/api/workorders/pickup-alerts` (Jean Pool)
- Suite de pruebas de integración `scripts/tests/verify-12-5.js` (`npm run test:pickup`) con verificación de plazos por empresa (15 vs 30 días), idempotencia, empresas inactivas, entrega desde no recogido, seguridad del endpoint de job, alertas y protección de datos reales (Jean Pool)
- Documentación de jobs en `Sistema/README.md` y variables en `.env.example` (`JOBS_TOKEN`, `JOB_NOT_PICKED_UP_MINUTES`) (Jean Pool)

### Added (Fase 12 - Tarea 12.4)
- Módulo `src/shared/utils/modelNormalizer.js` con función `normalizeModel(str)` que normaliza nombres de motos a solo caracteres alfanuméricos en minúsculas (`toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '')`), alineado con la expresión SQL `regexp_replace(lower(x), '[^a-z0-9]', '', 'g')` (Jean Pool)
- Filtros avanzados en `GET /api/inventory` (`getAll` en `src/modules/inventory/inventory.service.js`):
  - Filtro opcional `compatible_with=<modelo>`: busca productos cuyos `compatible_models` contengan el modelo indicado (comparación normalizada) (Jean Pool)
  - Filtro opcional `stock_status=low|out`: filtra productos con stock bajo (`0 < stock <= min_stock`) o agotados (`stock = 0`) (Jean Pool)
  - Ambos filtros 100% parametrizados y combinables con `search` (Jean Pool)
- Endpoint `GET /api/inventory/alerts` (`getAlerts`):
  - Restringido a roles `admin`, `cajero` y `almacenero` (rol `mecanico` responde HTTP 403 `FORBIDDEN`) (Jean Pool)
  - Retorna `{ out_of_stock: [...], low_stock: [...], total_alerts, total }` con `id, name, sku, stock, min_stock, category` ordenados por urgencia (Jean Pool)
- Endpoint `GET /api/inventory/:id/alternatives` (`getAlternatives`):
  - Accesible para cualquier usuario autenticado, sugiere hasta 5 productos activos con stock > 0 de la misma empresa (Jean Pool)
  - Prioriza por modelos compatibles compartidos (o compatibles con `?compatible_with=<modelo>`); si el producto original no tiene categoría (NULL), busca por modelos compartidos y si tampoco tiene modelos devuelve lista vacía `[]` (Jean Pool)
- Cruce transaccional de umbrales en `createSale` (`src/modules/sales/sales.service.js`):
  - `decrementStock` en `inventory.service.js` retorna `{ id, name, sku, stock_before, stock_after, min_stock }` (Jean Pool)
  - `createSale` rastrea productos directos y componentes de kits, agregando en la respuesta `stock_alerts: [...]` únicamente para los repuestos que por efecto de la venta cruzaron el umbral (`initial_stock > min_stock && final_stock <= min_stock`), sin repetir productos que ya estaban en nivel crítico (Jean Pool)
- Caso 19 en `scripts/tests/test-isolation.js` verificando el aislamiento multi-tenant estricto en `/api/inventory/alerts` y `/api/inventory/:id/alternatives` (Jean Pool)
- Suite de pruebas automatizadas `scripts/tests/verify-12-4.js` (`npm run test:stock`) con 30 pruebas cubriendo normalización ("HONDA CG.125", "honda cg-125", "Honda  CG125"), filtros low/out, RBAC en alertas, sugerencia inteligente de alternativas y alertas de stock en ventas directas y kits (Jean Pool)

### Added (Fase 12 - Tarea 12.3)
- Migración `scripts/migrations/011_notas_credito.sql`: creación de la tabla `credit_notes` (id SERIAL PK, company_id NOT NULL FK companies, invoice_id NOT NULL FK invoices UNIQUE, sale_id NOT NULL FK sales, serie VARCHAR(4) NOT NULL, numero INTEGER NOT NULL, motivo_code VARCHAR(2) NOT NULL CHECK ('01','02','06'), motivo_descripcion VARCHAR(250) NOT NULL, subtotal, igv, total NUMERIC(10,2) NOT NULL, xml_content TEXT, estado VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK ('pending','accepted','rejected','contingency'), cdr_response JSONB, created_by FK users, created_at, updated_at, UNIQUE (company_id, serie, numero), índices por `(company_id, created_at)` y `(sale_id)`) para soporte de Notas de Crédito Electrónicas Totales (RF-23) (Jean Pool)
- Emisión atómica de Notas de Crédito Electrónicas en `src/modules/sales/sales.service.js` (`voidSale`):
  - Admite opciones `{ void_reason, motivo_code }` o string `void_reason` (por defecto motivo '01' Anulación de la operación) (Jean Pool)
  - Validación de motivos según catálogo 09 de SUNAT: rechazo con HTTP 422 `INVALID_MOTIVO_FOR_BOLETA` si se intenta usar motivo '02' (Anulación por error en el RUC) en Boletas de Venta (Jean Pool)
  - Control de estados del comprobante previo a anulación: rechazo con HTTP 409 `INVOICE_NOT_ACCEPTED` si el comprobante asociado está en estado 'pending' o 'contingency' ("El comprobante B001-... aún no fue aceptado por SUNAT. Reintenta su envío antes de anular.") sin alterar inventario ni anular la venta (Jean Pool)
  - Si el comprobante está aceptado: asignación correlativa atómica en `invoice_series` (serie `BC01` para boletas y `FC01` para facturas), generación de XML simplificado con referencia al documento modificado y registro en `credit_notes` (Jean Pool)
  - Si el comprobante está rechazado o la venta no tiene comprobante: anulación interna y restitución de stock sin emisión de Nota de Crédito (Jean Pool)
  - Despacho post-commit al PSE simulado (`sendComprobante`): actualización a estado 'accepted' con CDR simulado o 'contingency' ante indisponibilidad, con registro de auditoría (`sale` `void`) incluyendo serie y correlativo de la NC (Jean Pool)
- Nuevos endpoints en módulo de facturación `src/modules/invoicing/`:
  - `GET /api/invoicing/credit-notes`: lista de notas de crédito de la empresa (Jean Pool)
  - `GET /api/invoicing/credit-notes/:id/ticket`: estructura de datos lista para impresión térmica del ticket de Nota de Crédito (Jean Pool)
  - `PATCH /api/invoicing/credit-notes/:id/retry`: reintento de envío al PSE de notas de crédito en contingencia (restringido a rol admin con auditoría de reintento) (Jean Pool)
  - Enriquecimiento de `GET /api/invoicing`: proyección mediante LEFT JOIN del campo `credit_note: { id, serie, numero, estado, motivo_code, motivo_descripcion, created_at }` o `null` en cada comprobante (Jean Pool)
- Métricas analíticas en `src/modules/dashboard/dashboard.service.js`: adición en `getInvoicingSummary` del conteo y total acumulado de notas de crédito aceptadas en el periodo (`credit_notes: { count, total }`) y verificación de exclusión de ventas anuladas en recaudación (Jean Pool)
- Caso 18 en `scripts/tests/test-isolation.js` verificando que las Notas de Crédito, tickets y reintentos permanecen 100% aislados entre empresas (Jean Pool)
- Suite de pruebas de verificación automatizadas `scripts/tests/verify-12-3.js` (`npm run test:credit-notes`) con 22 pruebas cubriendo emisión BC01/FC01, restricción de motivo 02 en boletas, rechazo ante contingencia previa, idempotencia, anulación sin comprobante, restitución exacta de stock y métricas en dashboard (Jean Pool)

### Added (Fase 12 - Tarea 12.2)
- Migración `scripts/migrations/010_pagos_mixtos.sql`: tabla `sale_payments` (id SERIAL PK, company_id NOT NULL FK, sale_id NOT NULL FK sales, method VARCHAR(20) NOT NULL CHECK ('efectivo','tarjeta','yape','plin'), amount NUMERIC(10,2) NOT NULL CHECK (amount > 0), reference VARCHAR(60), cash_received NUMERIC(10,2), change_given NUMERIC(10,2), created_at TIMESTAMPTZ) con índices `(company_id, sale_id)` y `(company_id, method)` (Jean Pool)
- Actualización de constraint en `sales.payment_method` (`sales_payment_method_check`) para admitir el valor `'mixto'` y backfill histórico idempotente de todas las ventas preexistentes en `sale_payments` (Jean Pool)
- Soporte dual en `src/modules/sales/sales.service.js` (`createSale`): compatibilidad retroactiva con `{ payment_method }` (crea un único pago por el total) y nuevo formato `{ payments: [{ method, amount, reference?, cash_received? }] }` (de 1 a 4 pagos) con validación matemática en céntimos enteros (`Math.round`) (Jean Pool)
- Control de cuadre exacto de pagos en `createSale` con rollback transaccional y error HTTP 422 `PAYMENT_MISMATCH` ("Los pagos suman S/ X y el total es S/ Y"), protegiendo inventario y stock ante descuadres (Jean Pool)
- Reglas de negocio para cobros: máximo un pago en efectivo por venta, cálculo automático de vuelto (`change_given = cash_received - amount`) exigiendo `cash_received >= amount` (422), restricción de `cash_received` a efectivo y validación de referencias alfanuméricas de hasta 60 caracteres (Jean Pool)
- Enriquecimiento de consultas en `getById` de ventas y `getTicketData` en `src/modules/invoicing/invoicing.service.js` retornando el arreglo `payments` con métodos, montos, referencias y vueltos sin alterar el contrato previo (Jean Pool)
- Agregación analítica en `src/modules/dashboard/dashboard.service.js`: cálculo de `revenue_by_payment_method` desde `sale_payments` mediante JOIN con `sales` (excluyendo anuladas), reflejando con exactitud la recaudación por cada canal de cobro en ventas mixtas (Jean Pool)
- Caso 1d en `scripts/tests/test-isolation.js` verificando el aislamiento estricto de los desgloses de pagos entre empresas en el dashboard (Jean Pool)
- Suite de pruebas de verificación automatizadas `scripts/tests/verify-12-2.js` (`npm run test:payments`) con 21 pruebas cubriendo compatibilidad legada, pagos mixtos, rollback ante descuadres, cálculo de vuelto, restricciones de métodos y consultas de ticket/dashboard (Jean Pool)

### Added (Fase 12 - Tarea 12.1)
- Módulo `src/modules/plans/aiUsage.service.js` con funciones `recordUsage` y `countMonthlySuccessfulScans` centralizando todo el acceso SQL a la tabla `ai_usage` (Regla 1 de backend.md); `inventory.aiClient.js` desacoplado como cliente puro de IA sin acceso a base de datos que retorna `{ data, usage }` (Jean Pool)
- Migración `scripts/migrations/009_planes.sql`: tabla `plans` (id SERIAL PK, code VARCHAR(30) UNIQUE NOT NULL, name VARCHAR(60) NOT NULL, price_pen NUMERIC(10,2) NOT NULL, max_users INTEGER, max_ai_scans_month INTEGER, features JSONB NOT NULL DEFAULT '{}', is_active BOOLEAN DEFAULT true, created_at) con semilla oficial 'mototrack' (S/ 99.00/mes, 10 usuarios, 1000 escaneos IA/mes, features {"whatsapp": true}) y asignación obligatoria en `companies.plan_id NOT NULL REFERENCES plans(id)` (Jean Pool)
- Módulo `src/modules/plans/plan.service.js` con función `getUsage(companyId)` que calcula el periodo mensual en huso horario `America/Lima`, cuenta escaneos exitosos en `ai_usage` (`ai_scans_this_month`) y usuarios activos (`users_active`), proyectando estado comercial sin exponer métricas internas de costos en USD ni tokens de IA (Jean Pool)
- Endpoint `GET /api/company/plan`: accesible para cualquier rol autenticado de la empresa, devuelve la información del plan comercial y consumo acumulado en el periodo actual (Jean Pool)
- Control de límites de plan en backend con respuesta HTTP 403 y código uniforme `PLAN_LIMIT_REACHED`:
  - `POST /api/inventory/scan`: validación previa antes de invocar a Gemini; si se alcanza `max_ai_scans_month` rechaza con mensaje amigable informando la renovación el día 1 sin generar consumo en `ai_usage` (Jean Pool)
  - Creación y reactivación de usuarios en `src/modules/users/users.service.js`: si se alcanza `max_users` activos se bloquea con 403 informando el límite del plan (Jean Pool)
- Asignación automática del plan oficial 'mototrack' en el flujo de registro público `POST /api/auth/register-company` (Jean Pool)
- Caso 17 en `scripts/tests/test-isolation.js` verificando que el consumo y consultas de `/api/company/plan` de una empresa permanecen 100% aislados de las demás (Jean Pool)
- Suite de verificación integral `scripts/tests/verify-12-1.js` (`npm run test:plans`) con 10 pruebas automatizadas cubriendo no cómputo de escaneos fallidos, bloqueo previo a Gemini al superar cupo, límite de usuarios activos, endpoint `/api/company/plan` y protección estricta de privacidad (Jean Pool)

### Added (Fase 12 - Tarea 12.0)
- Migración `scripts/migrations/008_ai_usage.sql`: creación de tabla `ai_usage` (id BIGSERIAL PK, company_id NOT NULL FK, user_id FK, model, input_tokens, output_tokens, thinking_tokens, latency_ms, success, error_code, estimated_cost_usd, created_at) con índice compuesto `(company_id, created_at)` para medición granular de consumo (Jean Pool)
- Función pura `mapGeminiError(err)` en `src/modules/inventory/inventory.aiClient.js` que clasifica y sanitiza errores de Gemini (`AI_NOT_CONFIGURED` para claves inválidas/vencidas, `AI_QUOTA` para límite 429/RESOURCE_EXHAUSTED, `AI_TIMEOUT` para demoras y `AI_SERVICE_ERROR` para fallos genéricos) garantizando que ninguna traza de infraestructura o credencial de Google se exponga al usuario (Jean Pool)
- Diagnóstico del servicio en `warmUp()` con registro de estados (`ok`, `invalid_key`, `unconfigured`, `unknown`) y exposición de `ai` en `GET /api/health` (Jean Pool)
- Registro no bloqueante de consumo de tokens y estimación de costos en USD por escaneo en `ai_usage`, cobrando tokens de pensamiento (`thinking_tokens`) como salida en base a variables de entorno `AI_PRICE_INPUT_PER_M` y `AI_PRICE_OUTPUT_PER_M` (Jean Pool)
- Script administrativo `scripts/ai-usage-report.js [YYYY-MM]` para consolidación mensual de escaneos, tokens y costos por taller en huso horario `America/Lima` (Jean Pool)
- Suite de pruebas automatizadas `scripts/tests/verify-12-0.js` (`npm run test:ai`) con validación unitaria de sanitización y prueba de integración de escaneo real con imagen (Jean Pool)
### Added (Fase 11 - Tarea 11.5)
- Migración `scripts/migrations/007_registro_talleres.sql`: agrega columnas `trial_ends_at TIMESTAMPTZ` y `terms_accepted_at TIMESTAMPTZ` a la tabla `companies` con retrocompatibilidad (NULL en empresas existentes para evitar expiración) (Jean Pool)
- Endpoint público `POST /api/auth/register-company`: registro atómico transaccional de nuevos talleres con validación de RUC Módulo 11 opcional, unicidad de RUC y correo (409), política de contraseñas seguras, aceptación de términos (Ley 29733), creación de usuario admin con `must_change_password = false`, registro en `audit_logs` (company y user create) y emisión directa de JWT (Jean Pool)
- Verificación de expiración de prueba en `authenticate.js` y `auth.service.js`: bloqueo con HTTP 403 `TRIAL_EXPIRED` cuando `status = 'trial'` y `trial_ends_at < now()` (Jean Pool)
- Proyección de `trial_ends_at` y cálculo en tiempo real de `days_left` en `GET /api/company` (Jean Pool)
- Proyección de métricas operativas de onboarding en `GET /api/dashboard` (`has_ruc`, `has_logo`, `active_users_count`, `total_active_products`, `all_time_sales_count`) para guiar la configuración inicial del taller (Jean Pool)
- Rate limiting con `express-rate-limit` en endpoints de autenticación: `loginRateLimiter` (máximo 10 intentos fallidos cada 15 min por IP+email con HTTP 429) y `registerCompanyRateLimiter` (máximo 5 registros por hora por IP con HTTP 429) (Jean Pool)
- Script de administración `scripts/activate-company.js <company_id>` para activar permanentemente talleres que adquieren su plan comercial, eliminando la fecha de expiración y auditando la activación (Jean Pool)
- Caso 16 en `scripts/tests/test-isolation.js` validando expiración de periodo de prueba, bloqueo de endpoints protegidos y aislamiento de talleres en trial (Jean Pool)
- Suite de pruebas automatizadas `scripts/tests/verify-11-5.js` (`npm run test:onboarding`) con 21 pruebas de registro, validaciones, rate limiting y ciclo de vida de prueba (Jean Pool)
### Added (Fase 11 - Tarea 11.4)
- Migración `scripts/migrations/006_auditoria.sql`: tabla `audit_logs` con PK `BIGSERIAL`, `company_id NOT NULL REFERENCES companies`, `user_id REFERENCES users`, `entity`, `entity_id`, `action`, `changes JSONB`, `created_at TIMESTAMPTZ`, índices `(company_id, created_at DESC)` y `(company_id, entity, entity_id)`, y trigger `trg_audit_logs_immutable` para inmutabilidad estricta (bloquea UPDATE y DELETE) (Jean Pool)
- Helper transaccional `src/shared/audit.js` con funciones `logAudit` y `diffObjects` para atomicidad estricta dentro de transacciones activas de PostgreSQL (Jean Pool)
- Auditoría en `src/modules/inventory/inventory.service.js` para creación, desactivación, margen negativo forzado y modificación con diff de precios, stock y compatibilidad (Jean Pool)
- Auditoría en `src/modules/sales/sales.service.js` para anulación de ventas (`void`) registrando motivo y stock restituido por producto (Jean Pool)
- Auditoría en `src/modules/invoicing/invoicing.service.js` para reintentos de comprobantes en contingencia (`retry_contingency`) (Jean Pool)
- Auditoría en `src/modules/users/users.service.js` para creación, desactivación, reactivación, cambio de rol y reseteo de contraseñas sin registrar claves ni hashes (Jean Pool)
- Auditoría en `src/modules/company/company.service.js` para cambios de configuración con enmascaramiento de `logo_data` ("logo cambiado") (Jean Pool)
- Módulo `src/modules/audit/` (`audit.routes.js`, `audit.controller.js`, `audit.service.js`) montado en `/api/audit` protegido para rol `admin` con filtros combinados y paginación (Jean Pool)
- Caso 15 en `scripts/tests/test-isolation.js` validando aislamiento de registros de auditoría entre empresas (Jean Pool)
- Suite de pruebas automatizadas `scripts/tests/verify-11-4.js` (`npm run test:audit`) con 21 pruebas de inmutabilidad, atomicidad, rollback, diffing y RBAC (Jean Pool)

### Added (Fase 11 - Tarea 11.3)
- Migración `scripts/migrations/005_usuarios_seguridad.sql`: agrega columnas `must_change_password BOOLEAN NOT NULL DEFAULT false` y `last_login_at TIMESTAMPTZ` a la tabla `users` (Jean Pool)
- Módulo `src/shared/utils/passwordPolicy.js` con validador de políticas de seguridad de contraseñas (mínimo 8 caracteres, al menos una letra y un número) (Jean Pool)
- Endpoint `POST /api/users/:id/reset-password` (solo admin, misma empresa): restablece contraseña temporal con `must_change_password = true` sin filtrar contraseñas en respuestas ni logs (Jean Pool)
- Endpoint `POST /api/auth/change-password` (autenticado): cambio de contraseña con verificación de clave actual (401), validación de política (422) y actualización a `must_change_password = false` (Jean Pool)
- Revocación inmediata en middleware `authenticate.js`: valida en cada petición mediante consulta directa con JOIN a BD que el usuario y la empresa sigan activos y no suspendidos, sincronizando el rol real en vivo (latencia promedio añadida: ~2.15 ms) (Jean Pool)
- Protecciones de integridad en `src/modules/users/users.service.js`: bloqueo de auto-desactivación y auto-degradación de rol de administradores (409), y protección del último administrador activo de la empresa (409) (Jean Pool)
- Unicidad de correo electrónico en creación de usuario responde con código HTTP 409 `EMAIL_ALREADY_EXISTS` (Jean Pool)
- Registro de `last_login_at` en inicio de sesión exitoso y exposición de `must_change_password` en `/api/auth/login` y `/api/auth/me` (Jean Pool)
- Caso 14 en `scripts/tests/test-isolation.js` validando aislamiento estricto de usuarios entre empresas (Jean Pool)
- Suite integral `scripts/tests/verify-11-3.js` (`npm run test:users`) con 33 pruebas automatizadas de seguridad, políticas, sincronización de rol en vivo y aislamiento (Jean Pool)

### Fixed (Fase 11 - Tarea 11.3)
- Estandarización de formato uniforme de respuesta de error `{ success: false, error: { message, code } }` en `errorHandler.js` y módulo `company` utilizando la clase compartida `src/shared/errors/AppError.js` (Jean Pool)

### Added (Fase 11 - Tarea 11.2b)
- Migración `scripts/migrations/004_igv_por_venta.sql`: agrega columna `igv_rate NUMERIC(4,3) NOT NULL` a la tabla `sales` preservando el 18% histórico para ventas previas (Jean Pool)
- Módulo `src/modules/company/` (`company.routes.js`, `company.controller.js`, `company.service.js`) montado en `/api/company` para lectura y configuración dinámica por empresa (Jean Pool)
- Endpoint `GET /api/company` accesible para todos los roles autenticados de la empresa (Jean Pool)
- Endpoint `PUT /api/company` restringido a rol `admin` con validaciones rigurosas (módulo 11 de SUNAT para RUC, detección de duplicados 409, límite 300 KB para logo base64, rangos de IGV, umbral y días para moto no recogida) (Jean Pool)
- Emisión de facturas y boletas vinculada a los datos fiscales reales de la empresa (`ruc`, `razon_social`, `direccion`) y rechazo 422 si el taller no ha completado su RUC y razón social (Jean Pool)
- Cálculo y persistencia dinámica de `igv_rate` por empresa en ventas e invoices, reflejado con tasa real en el ticket de venta (Jean Pool)
- Umbral de aprobación de órdenes de trabajo dinámico (`approval_threshold`) por empresa en lugar de constante estática (Jean Pool)
- Caso 13 en `scripts/test-isolation.js` validando aislamiento y RBAC de la configuración de empresa (Jean Pool)

### Added (Fase 11 - Tarea 11.2a)
- Migración `scripts/migrations/003_multi_tenant.sql`: creación de tabla `companies`, columna `company_id NOT NULL` con FK e índices en todas las tablas transaccionales (`users`, `products`, `kits`, `sales`, `vehicles`, `work_orders`, `invoices`, `notifications`) (Jean Pool)
- Claves compuestas de unicidad por empresa: `products_company_sku_key (company_id, sku)` y `vehicles_company_placa_key (company_id, placa)` (Jean Pool)
- Tabla `invoice_series (company_id, serie, last_number, PK(company_id, serie))` y correlativo atómico por empresa y serie mediante `INSERT ... ON CONFLICT DO UPDATE RETURNING last_number` (Jean Pool)
- Requisito de `company_id` en JWT (`authenticate.js`); rechazo 401 si falta y exposición en `req.user.company_id` (Jean Pool)
- Validación de estado de empresa en `auth.service.js`: rechazo 403 `COMPANY_INACTIVE` si la empresa está inactiva o suspendida (Jean Pool)
- Aislamiento estricto por `company_id` en todos los services y controllers: `inventory`, `workorders`, `sales`, `invoicing`, `users` y `dashboard` (Jean Pool)
- Los recursos de otra empresa devuelven HTTP 404 (no 403) para evitar revelación de existencia (Jean Pool)
- Script de inicialización de empresa de pruebas `scripts/seed-test-company.js` (`npm run seed:test-company`) (Jean Pool)
- Suite de pruebas automatizadas de aislamiento `scripts/test-isolation.js` (`npm run test:isolation`) que evalúa 12 casos de validación cruzada entre Empresa A y Empresa B (Jean Pool)
- Documentación del orden de arranque e instalación en `Sistema/README.md` (Jean Pool)

### Added (Fase 11 - Tarea 11.1b)
- Migración `scripts/migrations/002_categoria_producto.sql`: agrega columna `category VARCHAR(40)` e índice B-tree en tabla `products` (Jean Pool)
- Constante `PRODUCT_CATEGORIES` con las 12 categorías oficiales del taller en `src/modules/inventory/inventory.service.js` (Jean Pool)
- Validación de `category` (422 si no pertenece a la lista) y saneamiento de `compatible_models` (trim, sin duplicados, máximo 20) en `create` y `update` de inventario (Jean Pool)
- Ampliación de Gemini en `src/modules/inventory/inventory.aiClient.js`: detección de `detected_category`, sugerencia de `suggested_compatible_models` y discriminación de origen `compatibility_source` ('empaque' | 'inferido' | 'ninguno') (Jean Pool)
- Búsqueda `GET /api/inventory?search=` ampliada a `brand`, `category` y `array_to_string(compatible_models, ' ')` con SQL parametrizado (RF-08) (Jean Pool)

### Changed (Fase 11 - Tarea 11.1b)
- `src/modules/inventory/inventory.service.js`: `update()` admite vaciar `compatible_models` (`[]` → `'{}'`) y `category` (`null` → `NULL`) distinguiendo campos omitidos de enviados vacíos mediante evaluación condicional SQL (Jean Pool)
- `src/modules/inventory/inventory.aiClient.js`: timeout de 10 s configurable (`AI_TIMEOUT_MS`) que aborta con `AI_TIMEOUT` (HTTP 503) e instruye el registro manual (Jean Pool)
- `src/modules/inventory/inventory.aiClient.js`: prompt ajustado para delimitar la fuente `'empaque'` a texto visible en la imagen y restringir `'inferido'` a modelos y marcas comercializadas en Perú (Jean Pool)

### Added (Fase 11 - Tarea 11.1)
- Runner de migraciones SQL transaccionales `scripts/migrate.js` con registro en tabla `schema_migrations` y comando `npm run migrate` (Jean Pool)
- Migración `scripts/migrations/001_rol_almacenero.sql`: actualiza el CHECK constraint `users_role_check` en la tabla `users` para admitir el rol `almacenero` (Jean Pool)
- Soporte para el rol `almacenero` en `src/modules/users/users.service.js` agregándolo a `VALID_ROLES` (Jean Pool)
- Script de inicialización idempotente de usuarios demo `scripts/seed-demo-users.js` (`npm run seed:demo`) que crea `cajero@mototrack.local`, `almacenero@mototrack.local` y `mecanico@mototrack.local` validando `DEMO_USERS_PASSWORD` (Jean Pool)

### Changed (Fase 11 - Tarea 11.1)
- Permisos RBAC en `src/modules/inventory/inventory.routes.js`: los endpoints `POST /scan`, `POST /` y `PUT /:id` autorizan a `admin`, `cajero` y `almacenero` (Jean Pool)

### Added
- Esquema SQL de la tabla `products` con 13 columnas (sku, brand, compatible_models, cost_price, sale_price, stock, min_stock, ai_confidence, registration_method, is_active, timestamps) en `scripts/schema.sql` (Jean Pool)
- CRUD completo del módulo de inventario (`src/modules/inventory/`): getAll, getById, create, update, soft-delete (Jean Pool)
- Búsqueda por nombre y SKU con ILIKE a través de `GET /api/inventory?search=` (Jean Pool)
- Validación de margen de precio en service: `sale_price <= cost_price` lanza error controlado `NEGATIVE_MARGIN` (Jean Pool)
- Opción `force: true` en el body de create/update para que el Administrador fuerce márgenes negativos con justificación explícita (Jean Pool)
- Soft-delete en `DELETE /api/inventory/:id`: establece `is_active = false`, nunca borra el registro (Jean Pool)
- Respuesta 422 con mensaje claro cuando se detecta margen negativo sin confirmación (Jean Pool)
- Esquema SQL de las tablas `vehicles`, `work_orders` y `notifications` en `scripts/schema_workorders.sql` (Jean Pool)
- Módulo de Órdenes de Trabajo (`src/modules/workorders/`): CRUD completo con máquina de estados (Jean Pool)
- Función `findOrCreateVehicle`: crea el vehículo si la placa no existe; reutiliza el registro si ya existe (Jean Pool)
- Máquina de estados con 7 estados y transiciones válidas; transición inválida devuelve 422 `INVALID_TRANSITION` (Jean Pool)
- Regla RF-16: mover de `diagnostico` → `en_reparacion` con `additional_cost > 100` desvía automáticamente al estado `pendiente_aprobacion` (Jean Pool)
- Endpoints `PATCH /:id/approve` y `PATCH /:id/reject` para aprobación/rechazo del trabajo adicional (UC-03) (Jean Pool)
- Endpoint `PATCH /:id/not-picked-up` para marcar manualmente vehículos no recogidos (Jean Pool)
- Campo `terminado_at` se rellena automáticamente al pasar al estado `terminado` (RF-17) (Jean Pool)
- Historial de OT por placa: `GET /api/workorders/placa/:placa` (RF-14) (Jean Pool)
- Filtrado de OT por estado: `GET /api/workorders?status=` (Jean Pool)
- Stub de notificaciones: cada cambio de estado inserta fila en `notifications` y loguea en consola (Jean Pool)
- Esquema SQL de las tablas `kits`, `kit_items`, `sales` y `sale_items` en `scripts/schema_sales.sql` (Jean Pool)
- Funciones `decrementStock` y `restoreStock` agregadas a `inventory.service.js` para participar en transacciones externas (Jean Pool)
- Módulo de Ventas POS (`src/modules/sales/`): CRUD de ventas con soporte a productos individuales y kits (Jean Pool)
- Creación de ventas en transacción real: BEGIN / INSERT / decrementStock por cada ítem / COMMIT o ROLLBACK automático (Jean Pool)
- Cálculo de subtotal, IGV (18%) y total en el backend; el body del request nunca define el total (Jean Pool)
- Precio de venta congelado en `unit_price` de `sale_items` al momento de la venta (Jean Pool)
- Soporte a kits: vender un kit descuenta el stock de cada producto componente en la cantidad correcta (Jean Pool)
- Anulación de ventas (`PATCH /:id/void`): restaura stock de todos los ítems incluyendo componentes de kits (Jean Pool)
- Endpoints `GET /api/sales/kits` y `POST /api/sales/kits` para gestión de kits de productos (Jean Pool)
- Filtrado de ventas por estado: `GET /api/sales?status=` (Jean Pool)
- Esquema SQL de la tabla `invoices` en `scripts/schema_invoicing.sql` con UNIQUE en `sale_id`, correlativo `numero` SERIAL, campo `is_contingency` y `cdr_response` JSONB (Jean Pool)
- Módulo de Facturación Electrónica (`src/modules/invoicing/`): emisión de boletas y facturas con integración PSE simulada (Jean Pool)
- Simulador PSE en `invoicing.pseClient.js`: punto de integración documentado para reemplazar por SDK Nubefact real (Jean Pool)
- Generación de XML simplificado en `buildSimplifiedXml` con datos de venta, ítems, subtotal, IGV y total (Jean Pool)
- RF-29: idempotencia de comprobantes — facturar la misma venta dos veces retorna el invoice existente con `alreadyExists: true` (Jean Pool)
- RF-28: modo contingencia — si el PSE no está disponible el comprobante queda en estado `contingency` y la operación retorna éxito igual (Jean Pool)
- Endpoint `PATCH /api/invoicing/:id/retry` para reintentar comprobantes en contingencia (Jean Pool)
- Endpoint `GET /api/invoicing/pending` para listar comprobantes en estado contingency (Jean Pool)
- RF-30: `GET /api/invoicing/:id/status` devuelve `{ id, estado, is_contingency }` (Jean Pool)
- `GET /api/invoicing/:id/ticket` retorna JSON estructurado listo para que el frontend arme el ticket de impresión (Jean Pool)
- Esquema SQL de la tabla `users` y columnas `mechanic_id` / `force_approved_by` en `scripts/schema_auth.sql` (Jean Pool)
- Script de seed idempotente del primer Administrador: `npm run seed:admin` (Jean Pool)
- Middlewares `authenticate.js` (JWT Bearer) y `authorize(...roles)` (RBAC) en `src/shared/middlewares/` (Jean Pool)
- Módulo `src/modules/auth/`: `POST /api/auth/login` (público) y `GET /api/auth/me` (autenticado) (Jean Pool)
- Módulo `src/modules/users/`: CRUD admin-only de cuentas de usuario (Jean Pool)
- Login retorna el mismo mensaje de error si el email no existe o la contraseña es incorrecta (seguridad anti-enumeración) (Jean Pool)
- Retrofit `workorders.service.js`: `assignMechanic` valida `mechanic_id` en tabla `users` con `role='mecanico'`; `getAll/getById/getHistoryByPlaca` traen el nombre real del mecánico vía JOIN (Jean Pool)
- Retrofit `inventory.controller.js`: bloquea `force:true` con 403 si el rol no es `admin` antes de tocar la BD (Jean Pool)
- Retrofit `inventory.service.js`: `create/update` guardan `force_approved_by = userId` al aprobar márgenes negativos (Jean Pool)
- Retrofit de los 4 archivos `*.routes.js`: todas las rutas protegidas con `authenticate` + `authorize` por rol (Jean Pool)

### Changed
- La respuesta de `GET /api/workorders/`, `/:id` y `/placa/:placa` ahora expone los campos del vehículo (`placa`, `brand`, `model`, `customer_name`, `customer_phone`) directamente en el objeto principal de la Orden de Trabajo, en lugar de anidados bajo un objeto "vehicle". Decisión consciente: se prefiere la forma plana por simplicidad de consumo en frontend. (Jean Pool)
- `auth.service.js`: payload JWT confirmado con `{ id, role, name }` y `expiresIn: '8h'` (sin cambio de lógica, documentado como corrección Fase 6). (Jean Pool)

### Added (Fase 7)
- Módulo de Dashboard y Reportes (`src/modules/dashboard/`): 5 endpoints de solo lectura, admin-only (Jean Pool)
- `GET /api/dashboard` — panel combinado: ventas, inventario, OT y facturación en un solo JSON vía `Promise.all` (Jean Pool)
- `GET /api/dashboard/sales` — resumen de ventas por rango de fechas: total, ingresos, desglose por método de pago, top 5 productos (Jean Pool)
- `GET /api/dashboard/inventory` — total de productos activos, productos con stock bajo y valor total del inventario (Jean Pool)
- `GET /api/dashboard/workorders` — conteo de OT por estado y conteo de OT activas (Jean Pool)
- `GET /api/dashboard/invoicing` — conteo de comprobantes por estado; `pending_contingency` reutiliza `getPendingContingency()` de `invoicing.service.js` directamente (Jean Pool)

### Added (Fase 8)
- Dependencia `@google/genai` instalada (paquete oficial vigente de Google Gemini SDK) (Jean Pool)
- `src/modules/inventory/inventory.aiClient.js`: cliente Gemini con salida JSON estructurada garantizada (`responseSchema`), medición de latencia y AppError `AI_SERVICE_ERROR` en caso de fallo (Jean Pool)
- `POST /api/inventory/scan` (RF-01): escanea imagen de repuesto con Gemini `gemini-2.5-flash`, devuelve `detected_name`, `detected_brand`, `confidence`, `latency_ms` y `requires_confirmation`; nunca escribe en la BD (Jean Pool)
- `requires_confirmation: true` cuando `confidence < 80` — mismo patrón que `requiresApproval` en workorders (Jean Pool)
- Validación de tamaño de imagen antes de llamar a la IA: rechaza con 422 si supera 10 MB (Jean Pool)
- `GEMINI_API_KEY` añadida a `.env` y `.env.example` (Jean Pool)
- `ROADMAP.md` reescrito con el alcance actualizado (V1 vs V2, equipo en solitario desde Fase 6) (Jean Pool)

### Verified (Fase 8)
- Tarea 0: `create` y `update` en `inventory.service.js` ya guardaban correctamente `brand`, `compatible_models`, `ai_confidence` y `registration_method` desde la Fase 6. Cero cambios requeridos. (Jean Pool)
### Fixed
- Latencia del escaneo IA fuera de RF-01: se cambió el modelo de `gemini-3.6-flash` a `gemini-3.5-flash-lite` con `thinkingConfig.thinkingLevel: 'minimal'`, reduciendo la latencia de 7-27s a un rango estable de 2.0-2.4s. (Jean Pool)
- Se agregó `warmUp()` en `inventory.aiClient.js`, invocado sin bloquear el arranque en `server.js`, eliminando el cold-start de conexión en el primer escaneo tras reiniciar el servidor. (Jean Pool)
- Se forzó el idioma de salida del escaneo IA a español, corrigiendo una inconsistencia donde un mismo producto podía detectarse en español o inglés según la ejecución. (Jean Pool)

## [0.1.0] - Fase 1: Setup y Base de Datos
### Added
- Estructura de carpetas modular del backend (routes/controller/service por módulo) (Jean Pool)
- Conexión a PostgreSQL nativo mediante pool de conexiones (Jean Pool)
- Servidor Express corriendo en el puerto 4000 (Jean Pool)
- Endpoint de verificación GET /api/health (Jean Pool)
- Variables de entorno (.env) y script de inicialización de base de datos (Jean Pool)

<!--
=== INSTRUCCIONES PARA VILCHEZ Y ANGHELY ===

Cada vez que agreguen, cambien o arreglen algo en el proyecto, ANTES de hacer commit deben:

1. Abrir este archivo (CHANGELOG.md).
3. Agregar su cambio con el formato correspondiente:
   - ### Added    → para funcionalidades nuevas
   - ### Changed  → para cambios en funcionalidad existente
   - ### Fixed    → para correcciones de bugs
   - ### Removed  → para funcionalidad eliminada
4. Incluir su nombre entre paréntesis al final de cada línea.

Ejemplo:
   ### Added
   - Endpoint POST /api/workorders para crear órdenes de trabajo (Vilchez)

Cuando se libere una nueva versión, el equipo moverá todo lo de [Unreleased]
a una nueva sección con número de versión y fecha, por ejemplo:
   ## [0.2.0] - 2026-09-15

NUNCA editen ni eliminen entradas ya publicadas en versiones anteriores.
-->
