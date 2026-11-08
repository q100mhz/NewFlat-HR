#!/usr/bin/env bash
# Подключает коннектор к уже установленному nginx и выпускает SSL-сертификат Let's Encrypt.
# Берёт DOMAIN и APP_PORT из .env. Запуск:  bash scripts/nginx-site.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Нет файла .env — сначала запустите bash scripts/install.sh"; exit 1; }
DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2- | tr -d ' "')
APP_PORT=$(grep -E '^APP_PORT=' .env | cut -d= -f2- | tr -d ' "'); APP_PORT=${APP_PORT:-3000}
[ -n "$DOMAIN" ] || { echo "В .env не заполнен DOMAIN"; exit 1; }

SERVER_IP=$(curl -4 -fsS -m 5 https://ifconfig.me || true)
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
echo "Домен: $DOMAIN → $DNS_IP;  IP сервера: $SERVER_IP;  порт приложения: $APP_PORT"
if [ -n "$SERVER_IP" ] && [ "$DNS_IP" != "$SERVER_IP" ]; then
  echo "ВНИМАНИЕ: домен $DOMAIN не указывает на этот сервер. Добавьте A-запись $DOMAIN → $SERVER_IP у регистратора и повторите через 10–30 минут."
  exit 1
fi

CONF=/etc/nginx/sites-available/$DOMAIN.conf
cat > "$CONF" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 90s;
    }
}
NGINX
ln -sf "$CONF" /etc/nginx/sites-enabled/$DOMAIN.conf
nginx -t
systemctl reload nginx
echo "nginx: сайт $DOMAIN добавлен"

if ! command -v certbot >/dev/null; then apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx; fi
# certbot сам допишет HTTPS и редирект с http на https в этот же конфиг
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --register-unsafely-without-email
systemctl reload nginx
echo
echo "Готово. Проверьте в браузере: https://$DOMAIN/health"
