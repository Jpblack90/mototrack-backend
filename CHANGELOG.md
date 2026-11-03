# Changelog
Todos los cambios notables de este proyecto se documentan en este archivo.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
Cada entrada indica el integrante responsable entre paréntesis.

## [Unreleased]
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
2. Buscar la sección ## [Unreleased]
### Added (Fase 11 - Tarea 11.5)
- Migración `scripts/migrations/007_registro_talleres.sql`: agrega columnas `trial_ends_at TIMESTAMPTZ` y `terms_accepted_at TIMESTAMPTZ` a la tabla `companies` con retrocompatibilidad (NULL en empresas existentes para evitar expiración) (Jean Pool)
- Endpoint público `POST /api/auth/register-company`: registro atómico transaccional de nuevos talleres con validación de RUC Módulo 11 opcional, unicidad de RUC y correo (409), política de contraseñas seguras, aceptación de términos (Ley 29733), creación de usuario admin con `must_change_password = false`, registro en `audit_logs` (company y user create) y emisión directa de JWT (Jean Pool)
- Verificación de expiración de prueba en `authenticate.js` y `auth.service.js`: bloqueo con HTTP 403 `TRIAL_EXPIRED` cuando `status = 'trial'` y `trial_ends_at < now()` (Jean Pool)
- Proyección de `trial_ends_at` y cálculo en tiempo real de `days_left` en `GET /api/company` (Jean Pool)
- Proyección de métricas operativas de onboarding en `GET /api/dashboard` (`has_ruc`, `has_logo`, `active_users_count`, `total_active_products`, `all_time_sales_count`) para guiar la configuración inicial del taller (Jean Pool)
- Rate limiting con `express-rate-limit` en endpoints de autenticación: `loginRateLimiter` (máximo 10 intentos fallidos cada 15 min por IP+email con HTTP 429) y `registerCompanyRateLimiter` (máximo 5 registros por hora por IP con HTTP 429) (Jean Pool)
- Script de administración `scripts/activate-company.js <company_id>` para activar permanentemente talleres que adquieren su plan comercial, eliminando la fecha de expiración y auditando la activación (Jean Pool)
- Caso 16 en `scripts/tests/test-isolation.js` validando expiración de periodo de prueba, bloqueo de endpoints protegidos y aislamiento de talleres en trial (Jean Pool)
- Suite de pruebas automatizadas `scripts/tests/verify-11-5.js` (`npm run test:onboarding`) con 21 pruebas de registro, validaciones, rate limiting y ciclo de vida de prueba (Jean Pool) al inicio.
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
