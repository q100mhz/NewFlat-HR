#!/usr/bin/env bash
# Резервная копия БД: bash scripts/backup.sh  → backups/hr-ДАТА.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose exec -T db pg_dump -U hr hr | gzip > "backups/hr-$(date +%F-%H%M).sql.gz"
find backups -name '*.sql.gz' -mtime +14 -delete
echo "Готово: $(ls -t backups | head -1)"
