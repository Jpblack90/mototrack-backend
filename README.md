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

## Configuración de Red y Proxy (`TRUST_PROXY`)

Para la correcta resolución de IPs en los mecanismos de Rate Limiting y seguridad:

- **Entorno Local y Docker (por defecto):**  
  `TRUST_PROXY` no se define o se establece en `false`. En local, los clientes se conectan directamente al backend sin un proxy intermedio. Dejar `trust proxy` desactivado evita que usuarios malintencionados falsifiquen la cabecera `X-Forwarded-For` para eludir los límites de intentos.

- **Entorno de Producción en Cloud Run / Reverse Proxy:**  
  En Google Cloud Run o tras balanceadores de carga (Nginx, AWS ALB), se debe configurar la variable de entorno:
  ```env
  TRUST_PROXY=1
  ```
  Esto instruye a Express a confiar en el primer salto del proxy inverso administrado y extraer la IP legítima del cliente desde `X-Forwarded-For`.

## Activación de Talleres (Suscripción Manual)

Cuando un taller registrado durante el periodo de prueba (14 días gratis) adquiere una suscripción comercial activa, el administrador del sistema puede activar su cuenta de forma definitiva:

```bash
node scripts/activate-company.js <company_id>
```

**Efectos de la activación:**
- Modifica el estado de la empresa a `status = 'active'`.
- Remueve la fecha de expiración (`trial_ends_at = NULL`).
- Registra el evento de auditoría en `audit_logs` con `action = 'activate'`, `entity = 'company'`, `entity_id = <company_id>` y `user_id = NULL` (operación a nivel de sistema).

## Verificación y Suites de Pruebas

Para validar el correcto funcionamiento de la plataforma y el aislamiento multi-tenant:

- **Pruebas de Onboarding y Registro de Talleres (Tarea 11.5):**
  ```bash
  npm run test:onboarding
  ```
- **Pruebas de Aislamiento Multi-Tenant (16 casos):**
  ```bash
  npm run test:isolation
  ```
- **Pruebas de Gestión de Usuarios y Seguridad (Tarea 11.3):**
  ```bash
  npm run test:users
  ```
- **Pruebas del Módulo de Auditoría (Tarea 11.4):**
  ```bash
  npm run test:audit
  ```
