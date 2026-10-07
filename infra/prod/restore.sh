#!/bin/sh
# Khôi phục PostgreSQL (GHI ĐÈ). Dùng: ./restore.sh FILE.dump --force
set -eu
cd "$(dirname "$0")"
F="${1:?cần tệp dump}"; [ "${2:-}" = "--force" ] || { echo "ghi đè dữ liệu: thêm --force" >&2; exit 1; }
[ -s "$F" ] || { echo "tệp rỗng/không có" >&2; exit 1; }
docker compose exec -T postgres pg_restore --list < "$F" > /dev/null
docker compose stop hub
docker compose exec -T postgres psql -U hub -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS hub WITH (FORCE)' -c 'CREATE DATABASE hub OWNER hub'
docker compose exec -T postgres pg_restore -U hub -d hub --no-owner --exit-on-error < "$F"
docker compose up -d --no-build hub
for i in $(seq 1 45); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q hub)")" = healthy ] && { echo "OK hub healthy"; exit 0; }
  sleep 2
done
echo "hub chưa khỏe" >&2; exit 1
