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
APP_PORT=$(grep -E '^APP_PORT=' .env | cut -d= -f2- | tr -d ' "'); APP_PORT=${APP_PORT:-3000}
if ss -ltn 2>/dev/null | grep -qE "127.0.0.1:$APP_PORT\s|0.0.0.0:$APP_PORT\s|\*:$APP_PORT\s|\[::\]:$APP_PORT\s" && ! docker compose ps --status running 2>/dev/null | grep -q app; then
  echo "Порт $APP_PORT уже занят другой программой. Укажите в .env другой APP_PORT (например 3010) и запустите снова."; exit 1
fi
PROFILE=""
if ss -ltn 2>/dev/null | grep -qE ':443\s'; then
  echo "Порт 443 занят (nginx) — после запуска выполните: bash scripts/nginx-site.sh"
else
  PROFILE="--profile caddy"; echo "Порт 443 свободен — включаю встроенный Caddy (HTTPS)"
fi
docker compose $PROFILE up -d --build
echo "Жду запуска приложения..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/health" >/dev/null 2>&1; then echo "Приложение работает на порту $APP_PORT"; exit 0; fi
  sleep 2
done
echo "Приложение не ответило. Логи: docker compose logs --tail=50 app"; exit 1
