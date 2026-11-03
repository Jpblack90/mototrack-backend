# MotoTrack AI - Backend

Backend SaaS multi-tenant para taller de motocicletas. Desarrollado con Node.js, Express y PostgreSQL.

## Orden de Instalación y Puesta en Marcha

Para iniciar el entorno y la base de datos desde cero, sigue estrictamente este orden:

1. **Levantar los servicios de infraestructura con Docker:**
   ```bash
   docker compose up -d
   ```
   *(Si se realizaron cambios en el código backend o Dockerfile, ejecutar `docker compose up -d --build backend`).*

2. **Ejecutar las migraciones pendientes de base de datos:**
   ```bash
   npm run migrate
   ```
   *(Aplica los scripts en `scripts/migrations/` en orden transaccional e idempotente, incluyendo el esquema multi-tenant y la empresa inicial).*

3. **Inicializar el usuario Administrador del sistema:**
   ```bash
   npm run seed:admin
   ```
   *(Crea `admin@mototrack.local` vinculado a la empresa inicial si no existe).*

4. **Inicializar los usuarios de demostración:**
   ```bash
   npm run seed:demo
   ```
   *(Requiere `DEMO_USERS_PASSWORD` configurado en `.env`. Crea `cajero@mototrack.local`, `almacenero@mototrack.local` y `mecanico@mototrack.local`).*

## Verificación de Aislamiento Multi-Tenant

Para ejecutar la suite de pruebas de aislamiento estricto entre empresas:
```bash
npm run test:isolation
```
*(Crea la empresa de prueba `[PRUEBA] Taller B` con `npm run seed:test-company`, valida los 12 casos de aislamiento por tenant y desactiva lógicamente los datos de prueba al finalizar).*
