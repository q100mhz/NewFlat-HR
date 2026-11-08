#!/usr/bin/env bash
# Диагностика VPS: что занимает порты 80/443, есть ли nginx, docker, сертификаты.
# Запуск на сервере:  bash scripts/check-server.sh
set -u
echo "=== Система ==="; uname -a; (lsb_release -ds 2>/dev/null || cat /etc/os-release 2>/dev/null | head -2)
echo; echo "=== Docker ==="
if command -v docker >/dev/null; then docker --version; docker compose version 2>/dev/null || echo "docker compose НЕ найден"; else echo "Docker НЕ установлен → curl -fsSL https://get.docker.com | sh"; fi
echo; echo "=== Кто слушает порты 80 и 443 ==="
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':(80|443)\s' || echo "Порты 80/443 свободны → можно использовать встроенный Caddy (--profile caddy)"
echo; echo "=== Веб-серверы ==="
for s in nginx apache2 httpd caddy; do command -v $s >/dev/null && echo "найден: $s ($(systemctl is-active $s 2>/dev/null))"; done
echo; echo "=== Сертификаты Let's Encrypt ==="
ls /etc/letsencrypt/live/ 2>/dev/null || echo "каталог /etc/letsencrypt/live не найден"
echo; echo "=== Панели управления ==="
for p in /usr/local/fastpanel2 /usr/local/mgr5 /usr/local/ispmgr /opt/beget /usr/local/hestia; do [ -e $p ] && echo "найдена панель: $p"; done
echo; echo "Подсказка: если порт 443 занят nginx — используйте deploy/nginx.conf.example; если свободен — docker compose --profile caddy up -d"
