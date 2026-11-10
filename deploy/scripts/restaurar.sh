#!/usr/bin/env bash
# Restaura un respaldo .dump en la BD de producción (reemplaza los datos actuales).
# Uso: ~/mototrack/Sistema/deploy/scripts/restaurar.sh ~/mototrack.dump
set -euo pipefail
DUMP="${1:?Indica la ruta del archivo .dump}"
cd ~/mototrack
set -a; source .env.prod; set +a
C="docker compose -f Sistema/deploy/docker-compose.prod.yml --env-file .env.prod"
$C up -d db
until $C exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do sleep 2; done
set +e
$C exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges < "$DUMP"
RC=$?
set -e
[ $RC -ne 0 ] && echo "Aviso: pg_restore terminó con código $RC (suele ser por avisos de objetos inexistentes). Revisa los mensajes de arriba."
echo "Restauración terminada. Aplicando migraciones pendientes (si las hay)..."
$C up -d --build backend
$C exec -T backend npm run migrate
