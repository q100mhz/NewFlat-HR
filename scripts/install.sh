#!/usr/bin/env bash
# Первичная установка на VPS (Ubuntu/Debian). Запуск из папки проекта: bash scripts/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v docker >/dev/null; then
  echo "Устанавливаю Docker..."; curl -fsSL https://get.docker.com | sh
fi
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^SECRET_KEY=.*/SECRET_KEY=$(openssl rand -hex 32)/" .env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
  echo "Создан .env с секретами. Отредактируйте DOMAIN, PUBLIC_URL, ALLOWED_PORTALS, HH_* :  nano .env"
  exit 0
fi
PROFILE=""
if ! (ss -ltn 2>/dev/null | grep -qE ':443\s'); then PROFILE="--profile caddy"; echo "Порт 443 свободен — включаю встроенный Caddy (HTTPS)"; fi
docker compose $PROFILE up -d --build
sleep 5
curl -fsS http://127.0.0.1:${APP_PORT:-3000}/health && echo " — приложение работает"
