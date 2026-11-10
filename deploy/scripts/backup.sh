#!/usr/bin/env bash
# Respaldo de la base de datos (formato custom de pg_dump). Conserva los últimos 7.
# Programar a diario:  crontab -e  →  0 3 * * * ~/mototrack/Sistema/deploy/scripts/backup.sh
set -euo pipefail
cd ~/mototrack
set -a; source .env.prod; set +a
mkdir -p ~/backups
F=~/backups/mototrack_$(date +%Y%m%d_%H%M).dump
docker compose -f Sistema/deploy/docker-compose.prod.yml --env-file .env.prod exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$F"
ls -1t ~/backups/mototrack_*.dump | tail -n +8 | xargs -r rm --
echo "Respaldo creado: $F ($(du -h "$F" | cut -f1))"
