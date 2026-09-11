# ROADMAP — MotoTrack AI

Este documento indica QUÉ FALTA y QUIÉN LO TOMA. El detalle línea por línea de lo ya construido vive en `CHANGELOG.md` — no lo dupliques aquí.

## Estado General

| Fase | Módulo | Estado | Responsable |
|---|---|---|---|
| 1 | Setup (servidor + BD) | ✅ Completo | Jean Pool |
| 2 | Inventario (CRUD + IA placeholder) | ✅ Completo | Jean Pool |
| 3 | Órdenes de Trabajo | ✅ Completo | Jean Pool |
| 4 | Ventas / POS / Kits | ✅ Completo | Jean Pool |
| 5 | Facturación SUNAT (mock PSE) | 🔄 En curso | Jean Pool |
| 6 | Autenticación y Roles (JWT) | ⏳ Pendiente | Jean Pool |
| 7 | Frontend Web (React.js) | ⏳ Pendiente | Vilchez |
| 8 | App Móvil (React Native) | ⏳ Pendiente | Vilchez |
| 9 | Suite de QA automatizada | ⏳ Pendiente | Vilchez |
| 10 | IA de Visión Computacional | ⏳ Pendiente | Anghely |
| 11 | Docker + Infraestructura Cloud (GCP) | ⏳ Pendiente | Anghely |
| 12 | Dashboard y Reportes | ⏳ Pendiente | Jean Pool |

## Trabajo Disponible AHORA en Paralelo (no depende de Facturación)

### Vilchez — Frontend & QA

1. **Frontend Web — Inventario** (prioridad 1). Endpoints ya estables: `GET/POST/PUT/DELETE /api/inventory`. Incluir en la UI el flujo de margen negativo: si el backend responde 422 con `NEGATIVE_MARGIN`, mostrar un modal de confirmación que reenvíe la misma petición con `force: true`.
2. **Frontend Web — POS / Ventas.** Endpoints: `GET /api/sales/kits`, `POST /api/sales`. El total mostrado en pantalla es solo referencial — el monto real siempre lo calcula el backend en la respuesta.
3. **Frontend Web — Tablero de Órdenes de Trabajo.** Vista tipo kanban por estado. Endpoints: `GET/POST /api/workorders`, `PATCH /api/workorders/:id/status`, `/approve`, `/reject`. Los estados y transiciones válidas están en `VALID_TRANSITIONS` dentro de `workorders.service.js` — no los inventes en el frontend, tráelos reflejados del backend.
4. **App Móvil — Vista de Mecánico.** Lista de OT y botón de cambio de estado. Nota: hasta que exista la Fase 6 (Auth), usar `mechanic_name` como filtro simple en vez de un login real.
5. **Suite de QA automatizada (Jest + Supertest).** No depende de nadie, se puede empezar hoy mismo. Priorizar los casos límite ya validados manualmente en Postman: margen negativo, transición de estado inválida, stock insuficiente, doble anulación de venta.

### Anghely — IA & Cloud Infrastructure

1. **Endpoint de escaneo IA** (prioridad 1). Crear `POST /api/inventory/scan` como endpoint NUEVO y AISLADO — no modificar el CRUD existente de `inventory.service.js`. Recibe una imagen, la envía a un servicio de Visión Computacional, y devuelve `{ brand, model, confidence }`. Estos valores alimentan los campos `ai_confidence` y `registration_method` que ya existen en la tabla `products` desde la Fase 2, esperando este dato.
2. **Dockerización del backend actual.** `Dockerfile` + `docker-compose.yml` para lo que ya existe (servidor Node + PostgreSQL). Es contenerizar lo construido, no cambiar lógica de negocio.
3. **Setup inicial de infraestructura GCP.** Crear el proyecto en Google Cloud, evaluar Cloud SQL vs. mantener PostgreSQL en Docker durante desarrollo, dejar documentada la decisión y el plan de despliegue para cuando el backend esté funcionalmente completo (después de la Fase 6).

### Jean Pool — Backend

- Fase 5: Facturación SUNAT (en curso).
- Fase 6: Autenticación y Roles — bloqueante real para: asignación de mecánico a un usuario de verdad (hoy es texto libre), y restringir "forzar margen negativo" solo a rol Administrador.
- Fase 7: Dashboard y Reportes — depende de que los demás módulos tengan datos reales acumulados.

## Reglas de Convivencia en el Repositorio

- Cada quien trabaja en su propia rama (`feature/frontend-inventario`, `feature/ia-scan`, `feature/docker`, etc.). Nunca commit directo a `main`.
- Antes de abrir un Pull Request: correr `npm run dev` localmente y confirmar que `/api/health` y los endpoints existentes siguen respondiendo.
- `CHANGELOG.md` se actualiza DENTRO del mismo Pull Request donde se hizo el cambio, no después.
- Si necesitas un endpoint o una tabla que no existe todavía, avísalo en el grupo ANTES de crearlo por tu cuenta — evita que dos personas construyan lo mismo con nombres distintos.
