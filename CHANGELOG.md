# Changelog
Todos los cambios notables de este proyecto se documentan en este archivo.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
Cada entrada indica el integrante responsable entre paréntesis.

## [Unreleased]
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
2. Buscar la sección ## [Unreleased] al inicio.
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
