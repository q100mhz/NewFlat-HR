#!/usr/bin/env bash
# Обновление до последней версии из GitHub: bash scripts/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
PROFILE=""; docker compose --profile caddy ps --services --filter status=running 2>/dev/null | grep -q caddy && PROFILE="--profile caddy"
docker compose $PROFILE up -d --build
docker image prune -f >/dev/null
echo "Обновлено."
