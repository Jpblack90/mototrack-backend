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
