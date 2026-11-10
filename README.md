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

## Gestión de Suscripciones y Cobro Manual (Yape / Transferencia) (RF-27)

MotoTrack AI implementa cobro manual de suscripción sin intermediarios financieros ni comisiones de pasarela. Los talleres abonan por Yape, Plin, transferencia bancaria o efectivo.

### 1. Modelo de Facturación y Estados
- **`trial`**: taller en periodo de prueba gratuita (14 días).
- **`active`**: taller con suscripción pagada al día (`paid_until >= hoy`) o taller interno/demostración (`paid_until IS NULL`).
- **`grace`**: suscripción vencida dentro del plazo de gracia de cortesía (`paid_until < hoy <= paid_until + BILLING_GRACE_DAYS`, por defecto 5 días). El taller conserva acceso completo para no interrumpir operaciones críticas mientras gestiona el pago.
- **`suspended`**: periodo de gracia expirado (`paid_until + BILLING_GRACE_DAYS < hoy`). El sistema bloquea el inicio de sesión y peticiones autenticadas con código HTTP 403 `SUBSCRIPTION_EXPIRED`, retornando la fecha de vencimiento y las instrucciones de abono. No se borra información.

### 2. Registro Manual de Pagos (`record-payment.js`)
El administrador del sistema registra los pagos recibidos mediante el script CLI:

```bash
node scripts/record-payment.js --company <id> --amount <S/> --method <yape|plin|transferencia|efectivo> [--ref <n.º de operación>] [--months 1] [--notes "..."]
```

**Reglas de negocio aplicadas en una única transacción atómica:**
- **No pérdida de días acumulados**: la nueva fecha de vencimiento se calcula como `GREATEST(paid_until, hoy) + N meses`. Si el taller abona anticipadamente, no pierde los días restantes de su ciclo anterior.
- Modifica el estado a `status = 'active'` y limpia `trial_ends_at = NULL`.
- Inserta el registro en la tabla `subscription_payments` con el período cubierto (`period_from` a `period_to`), método, monto y referencia.
- Registra el evento en `audit_logs` con `action = 'subscription_payment'`, `entity = 'company'`.

### 3. Variables de Entorno de Facturación
- `BILLING_GRACE_DAYS`: días de gracia tras la fecha de expiración (por defecto `5`).
- `PAYMENT_INSTRUCTIONS`: mensaje institucional que se muestra a los administradores y en la pantalla de suspensión (por ejemplo `"Yape al 987654321 a nombre de MotoTrack AI"`).
- `JOB_SUBSCRIPTIONS_MINUTES`: intervalo de ejecución del job de suspensión automática en minutos (por defecto `60`; `0` en serverless).

## Procesos en Segundo Plano y Jobs (RF-17, RF-27)

El sistema incluye jobs automáticos para tareas periódicas:

### A. Marcación automática de motos no recogidas (RF-17)
Revisa órdenes terminadas que superan `c.not_picked_up_days`, pasándolas a `no_recogido`.
- CLI: `npm run job:not-picked-up`
- HTTP: `POST /api/jobs/not-picked-up` con `X-Job-Token`

### B. Suspensión automática de suscripciones vencidas (RF-27)
Revisa empresas con `paid_until + BILLING_GRACE_DAYS < hoy` y estado activo/gracia, actualizando a `status = 'suspended'` y registrando auditoría.
- Temporizador interno periódico cada `JOB_SUBSCRIPTIONS_MINUTES` minutos.
- CLI: `npm run job:subscriptions`
- HTTP: `POST /api/jobs/subscriptions` con `X-Job-Token`

## Avisos al Cliente por WhatsApp (RF-15)

El sistema soporta el envío de avisos sobre el estado de la moto a los clientes vía WhatsApp.

- **Fase 1 (Implementada - Sin costo / wa.me):**
  - Genera enlaces directos a `https://wa.me/51XXXXXXXXX?text=<mensaje>` con el mensaje prearmado y codificado de forma segura.
  - El cajero o administrador envía el aviso desde el WhatsApp del taller con un solo clic, sin recurrir a APIs no oficiales que infrinjan los términos de servicio de WhatsApp.
  - Registro de consentimiento informado en cumplimiento de la Ley N° 29733 (Protección de Datos Personales).
  - Ciclo de vida completo: `pending` (por enviar), `opened` (enlace abierto e idempotente), `skipped` (omitido).
- **Fase 2 (Programada para Fase 13 - Automatización total):**
  - Integración nativa con la API oficial de Meta (WhatsApp Business Cloud API) para despacho 100% automático desatendido y plantillas verificadas.

## Facturación Electrónica PSE ("Trae tu Facturador" / Nubefact)

El sistema soporta la integración con Proveedores de Servicios Electrónicos (PSE) bajo el modelo **"trae tu facturador"**: cada taller conecta su propia cuenta de Nubefact (ruta de API y token de autorización) o utiliza el modo simulado de desarrollo (RF-23, RF-28, RF-29).

### 1. Variables de Entorno y Cifrado
- **`PSE_ENCRYPTION_KEY`** (requerida): clave simétrica de 32 bytes codificada en Base64 para cifrar los tokens de autorización del PSE con **AES-256-GCM** (con IV de 12 bytes y auth tag de 16 bytes).
  ```bash
  # Generar una clave segura de 32 bytes en base64:
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
- **Zero-Leak de Credenciales**: el token descifrado nunca se retorna en las respuestas de la API (`GET /api/company` devuelve únicamente `pse_token_set: boolean` y `pse_token_last4: string`) ni se expone en `audit_logs` ni en los logs de consola del servidor.

### 2. Endpoints de Configuración PSE y Series (Admin)
- `PUT /api/company`: actualiza la configuración de la empresa incluyendo proveedor (`pse_provider`: `'simulado'` | `'nubefact'`), ruta de API (`pse_url`), token opcional (`pse_token`) y series por defecto (`series_boleta`, `series_factura`, `series_nc_boleta`, `series_nc_factura`).
- `POST /api/company/pse/test`: prueba de conectividad y autenticación con Nubefact (`consultar_comprobante` dummy) sin persistir los cambios en la base de datos.
- `GET /api/company/series`: lista el último correlativo emitido (`last_number`) para cada una de las series configuradas del taller (`B001`, `F001`, `BC01`, `FC01`).
- `PUT /api/company/series/:serie`: ajuste manual de correlativo por parte del administrador. Por seguridad tributaria, únicamente permite incrementar el valor (`last_number`), rechazando decrementos con código 422.

### 3. Emisión Desacoplada e Idempotencia
- **Despacho Post-COMMIT**: el comprobante o nota de crédito se crea con estado `pending` dentro de la transacción local de PostgreSQL (`invoices` / `credit_notes`). La llamada HTTP externa al PSE se efectúa **fuera y después del `COMMIT`**, garantizando que un fallo o timeout de red nunca revierta los registros financieros de la base de datos.
- **Resolución Automática de Duplicados**: si Nubefact responde con un error de comprobante duplicado (Código 23: `"Este documento ya existe en NubeFacT"`), el adaptador ejecuta automáticamente `consultar_comprobante`, recuperando los enlaces oficiales de PDF/XML, el código hash y la cadena QR devueltos por SUNAT. Si la consulta determina que el comprobante no existe (Código 24), el comprobante queda en contingencia y se audita con prefijo `[PSE]`.

### 4. Documentación Oficial y Ejemplos de Referencia (`Sistema/docs/pse/`)
En el directorio `docs/pse/nubefact/` se almacenan las especificaciones oficiales descargadas directamente desde los canales de Nubefact:
- `docs/pse/nubefact/MANUAL_INTEGRACION_JSON.pdf`: Manual oficial completo de integración JSON (enlace oficial desde https://www.nubefact.com/integracion).
- `docs/pse/nubefact/MANUAL_INTEGRACION_JSON.txt`: Versión texto estructurado del manual para búsqueda y auditoría de campos y códigos de error (Pág. 15: Códigos 10, 20, 21, 23, 24).
- `docs/pse/nubefact/EJEMPLOS-DE-ARCHIVOS-JSON.zip` y subcarpeta `ejemplos/`: Archivos JSON oficiales de ejemplo para boletas (`EJEMPLO JSON GENERAR CPE BOLETA 1 GRAVADA.txt`), facturas (`EJEMPLO JSON GENERAR CPE FACTURA 1 GRAVADA.txt`), notas de crédito (`EJEMPLO JSON GENERAR CPE NOTA CREDITO 1 PARA FACTURA.txt`) y consultas (`EJEMPLO JSON CONSULTAR CPE BOLETA.txt`), descargados desde https://www.nubefact.com/downloads/EJEMPLOS-DE-ARCHIVOS-JSON.

## Verificación y Suites de Pruebas

Para validar el correcto funcionamiento de la plataforma y el aislamiento multi-tenant:

- **Pruebas de Cobro y Facturación de Suscripciones (Tarea 13.2):**
  ```bash
  npm run test:billing
  ```
- **Pruebas de Facturación Electrónica PSE Nubefact (Tarea 13.1):**
  ```bash
  npm run test:pse
  ```
- **Ejecución Completa de Todas las Suites de Pruebas (14 suites):**
  ```bash
  npm run test:all
  ```
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
