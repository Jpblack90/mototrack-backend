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

## Entorno de Producción y Seguridad (`ENABLE_TEST_HOOKS`)

En entornos de producción, el backend debe ejecutarse estrictamente con:
```env
NODE_ENV=production
```
y **sin definir** la variable de entorno `ENABLE_TEST_HOOKS`.

Por regla de seguridad, cuando `ENABLE_TEST_HOOKS !== '1'` o `NODE_ENV === 'production'`:
- Todas las trampas y utilitarios de prueba (`X-Force-Audit-Fail`, `X-Force-Void-Fail`, `FORCE_AUDIT_FAIL`, `FORCE_VOID_FAIL`) permanecen completamente desactivadas por defecto.
- El endpoint de desarrollo para reiniciar rate limiters (`POST /api/auth/reset-rate-limit`) no se registra en las rutas de la aplicación (responde `404 Not Found`).

## Activación de Talleres (Suscripción Manual)

Cuando un taller registrado durante el periodo de prueba (14 días gratis) adquiere una suscripción comercial activa, el administrador del sistema puede activar su cuenta de forma definitiva:

```bash
node scripts/activate-company.js <company_id>
```

**Efectos de la activación:**
- Modifica el estado de la empresa a `status = 'active'`.
- Remueve la fecha de expiración (`trial_ends_at = NULL`).
- Registra el evento de auditoría en `audit_logs` con `action = 'activate'`, `entity = 'company'`, `entity_id = <company_id>` y `user_id = NULL` (operación a nivel de sistema).

## Procesos en Segundo Plano y Jobs (RF-17)

El sistema incluye el job de **marcación automática de motos no recogidas**, el cual revisa órdenes terminadas cuyo plazo de espera supera el configurado por la empresa (`c.not_picked_up_days`), pasándolas a `no_recogido`, registrando la auditoría y notificando al cliente. Existen tres formas de ejecutarlo:

1. **Temporizador Interno (Entorno Local y Docker por defecto):**
   - Se ejecuta al iniciar el servidor y de forma periódica cada `JOB_NOT_PICKED_UP_MINUTES` minutos (por defecto 60).
   - Los fallos se capturan internamente con el prefijo `[JOB]` sin interrumpir el proceso del servidor.
   - Configuración en `.env`: `JOB_NOT_PICKED_UP_MINUTES=60`.

2. **Endpoint Externo para Cloud Scheduler (Entornos Serverless como Google Cloud Run):**
   - En Cloud Run o contenedores serverless efímeros, el temporizador interno se desactiva configurando `JOB_NOT_PICKED_UP_MINUTES=0`.
   - Google Cloud Scheduler invoca el endpoint HTTP mediante una petición `POST /api/jobs/not-picked-up`.
   - El endpoint no utiliza JWT sino la cabecera `X-Job-Token`, validada en tiempo constante (`crypto.timingSafeEqual`) contra la variable de entorno `JOBS_TOKEN`.

3. **Script CLI Manual:**
   - Puede ejecutarse manualmente desde la terminal mediante el script npm:
   ```bash
   npm run job:not-picked-up
   ```

## Avisos al Cliente por WhatsApp (RF-15)

El sistema soporta el envío de avisos sobre el estado de la moto a los clientes vía WhatsApp.

- **Fase 1 (Implementada - Sin costo / wa.me):**
  - Genera enlaces directos a `https://wa.me/51XXXXXXXXX?text=<mensaje>` con el mensaje prearmado y codificado de forma segura.
  - El cajero o administrador envía el aviso desde el WhatsApp del taller con un solo clic, sin recurrir a APIs no oficiales que infrinjan los términos de servicio de WhatsApp.
  - Registro de consentimiento informado en cumplimiento de la Ley N° 29733 (Protección de Datos Personales).
  - Ciclo de vida completo: `pending` (por enviar), `opened` (enlace abierto e idempotente), `skipped` (omitido).
- **Fase 2 (Programada para Fase 13 - Automatización total):**
  - Integración nativa con la API oficial de Meta (WhatsApp Business Cloud API) para despacho 100% automático desatendido y plantillas verificadas.

## Verificación y Suites de Pruebas

Para validar el correcto funcionamiento de la plataforma y el aislamiento multi-tenant:

- **Pruebas de Avisos por WhatsApp (Tarea 12.6):**
  ```bash
  npm run test:whatsapp
  ```
- **Pruebas de Motos No Recogidas y Scheduler (Tarea 12.5):**
  ```bash
  npm run test:pickup
  ```
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
