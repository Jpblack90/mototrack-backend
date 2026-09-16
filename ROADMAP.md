# ROADMAP — MotoTrack AI

## Estado General (actualizado 2026-09-15 — desarrollo en solitario desde Fase 6)

| Fase | Módulo | Estado |
|---|---|---|
| 1 | Setup (servidor + BD) | ✅ Completo |
| 2 | Inventario (CRUD + campos IA) | ✅ Completo |
| 3 | Órdenes de Trabajo | ✅ Completo |
| 4 | Ventas / POS / Kits | ✅ Completo |
| 5 | Facturación SUNAT (mock PSE) | ✅ Completo |
| 6 | Autenticación y Roles (JWT) | ✅ Completo |
| 7 | Dashboard y Reportes | ✅ Completo |
| 8 | Escaneo con IA (Gemini) | 🔄 En curso |
| 9 | Frontend Web (React.js, responsive) | ⏳ Pendiente |
| 10 | Docker + Despliegue a GCP | ⏳ Pendiente |

## Decisión de Alcance — V1 vs V2 (registrada 2026-09-15)

Ante el cambio de equipo de 3 personas a desarrollo en solitario, se recorta el alcance de la entrega V1 así:

### Postergado a V2 (fuera del alcance de esta entrega)
- App Móvil nativa (React Native) — se reemplaza por un Frontend Web responsivo, usable desde el navegador del celular.
- Suite de pruebas automatizadas (Jest/Supertest) — la validación de V1 se sostiene en pruebas manuales con evidencia JSON cruda, disciplina ya aplicada desde la Fase 2.

### Orden de trabajo restante para V1
8. Escaneo con IA (Gemini) — completa RF-01, el diferenciador principal del producto.
9. Frontend Web (React.js) — consume los endpoints ya construidos (Inventario, OT, Ventas, Facturación, Dashboard).
10. Docker + despliegue a GCP.

## Riesgo aceptado
Sin suite de QA automatizada, todo cambio futuro depende de validación manual disciplinada por escenario — no hay red de seguridad de regresión automática.
