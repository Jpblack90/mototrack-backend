# Despliegue de MotoTrack AI en Google Cloud (producción)

Arquitectura: **1 VM (Compute Engine, Ubuntu 24.04) con Docker Compose** →
`Caddy (HTTPS 443)` → `nginx + React (frontend)` → `/api` → `Node/Express (backend)` → `PostgreSQL 16`.
Solo los puertos 80/443 quedan abiertos a internet; la base de datos y la API no se exponen directamente.

---

## Paso 0 — En tu PC (Windows): subir el código y exportar la base de datos

```powershell
cd "C:\Users\crpol\Documents\UTP\Java script avanzado (1SI56)"

# 0.1 Subir el código a GitHub (los repos son públicos: nunca subas .env)
cd Sistema;            git add deploy; git commit -m "chore(deploy): producción en GCP con Docker Compose y Caddy"; git push; cd ..
cd mototrack-frontend; git add nginx.conf; git commit -m "feat(web): nginx reenvía /api al backend (mismo dominio)"; git push; cd ..

# 0.2 Exportar la base de datos (dentro del contenedor, para no dañar el archivo binario)
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/mototrack.dump'
docker compose cp db:/tmp/mototrack.dump .\mototrack.dump
```
Queda `mototrack.dump` en la carpeta raíz (no lo subas a GitHub: tiene datos y contraseñas cifradas).

## Paso 1 — Crear la VM en Google Cloud (consola web)

1. https://console.cloud.google.com → activar la **prueba gratuita** → crear el proyecto **mototrack-ai**.
2. **Compute Engine → Instancias de VM → Crear instancia**:
   - Nombre: `mototrack-vm` · Región: `southamerica-west1 (Santiago)` · Zona: `a`
   - Tipo de máquina: **e2-small** (2 vCPU, 2 GB)
   - Disco de arranque: **Ubuntu 24.04 LTS (x86/64)**, 20 GB, disco persistente balanceado
   - Firewall: marcar **Permitir tráfico HTTP** y **Permitir tráfico HTTPS**
3. **Red de VPC → Direcciones IP**: en la IP externa de `mototrack-vm`, **Reservar / promover a estática**.
4. Tu dominio será la IP con guiones + `.sslip.io`. Ej.: IP `34.176.10.20` → `34-176-10-20.sslip.io`.

## Paso 2 — Preparar la VM (botón **SSH** de la instancia)

```bash
git clone https://github.com/Jpblack90/mototrack-backend.git ~/mototrack/Sistema
git clone https://github.com/Jpblack90/mototrack-frontend.git ~/mototrack/mototrack-frontend
bash ~/mototrack/Sistema/deploy/scripts/instalar-docker.sh
```
Cierra la ventana SSH y ábrela de nuevo.

## Paso 3 — Configurar los secretos

```bash
cd ~/mototrack
cp Sistema/deploy/env.prod.example .env.prod
openssl rand -hex 32   # ejecútalo 3 veces: JWT_SECRET, JOBS_TOKEN y (con -hex 16) POSTGRES_PASSWORD
nano .env.prod         # completa DOMAIN, contraseñas nuevas, y copia GEMINI_API_KEY y PSE_ENCRYPTION_KEY de tu .env local
chmod 600 .env.prod
```

## Paso 4 — Restaurar la base de datos y levantar todo

1. En la ventana SSH: rueda dentada (⚙) → **Subir archivo** → elige `mototrack.dump`. Queda en `~/mototrack.dump`.
2. Ejecuta:
```bash
bash ~/mototrack/Sistema/deploy/scripts/restaurar.sh ~/mototrack.dump
cd ~/mototrack && docker compose -f Sistema/deploy/docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f Sistema/deploy/docker-compose.prod.yml --env-file .env.prod ps
```
La primera compilación tarda 5–10 minutos.

## Paso 5 — Verificar

- `https://TU-DOMINIO/api/health` → `{"status":"ok","ai":"ok",...}`
- `https://TU-DOMINIO` → login de la web.
- App móvil: engranaje del login → **Servidor** → `https://TU-DOMINIO/api` → Probar conexión → Guardar.
- **Cambia la contraseña del admin** desde la web (la del seed es pública en GitHub).

## Paso 6 — Respaldos automáticos

```bash
crontab -e
# agrega la línea:
0 3 * * * /home/$USER/mototrack/Sistema/deploy/scripts/backup.sh >> /home/$USER/backups/backup.log 2>&1
```

---

## Actualizar a una versión nueva

```bash
cd ~/mototrack/Sistema && git pull && cd ../mototrack-frontend && git pull && cd ..
docker compose -f Sistema/deploy/docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f Sistema/deploy/docker-compose.prod.yml --env-file .env.prod exec -T backend npm run migrate
```

## Problemas comunes

| Síntoma | Causa probable | Solución |
|---|---|---|
| El navegador dice que el certificado no es válido | Caddy aún no obtiene el certificado o el dominio no coincide con la IP | Revisar `DOMAIN` en `.env.prod`; ver `docker compose ... logs caddy` |
| `502 Bad Gateway` | El backend se cayó o aún está compilando | `docker compose ... ps` y `logs backend` |
| La IA responde "no configurada" | Falta `GEMINI_API_KEY` | Completar en `.env.prod` y `up -d backend` |
| La app no conecta | URL del servidor mal escrita | Debe terminar en `/api` y empezar con `https://` |
| La VM se quedó sin memoria al compilar | 2 GB justos | El script crea swap de 2 GB; repetir `up -d --build` |
