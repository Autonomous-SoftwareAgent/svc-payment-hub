#!/bin/sh
# Sao lưu PostgreSQL (VM Linux). Dùng: ./backup.sh [OUT_DIR] [KEEP]   (chạy trong infra/prod cạnh docker-compose.yml và .env)
set -eu
cd "$(dirname "$0")"
OUT="${1:-./backups}"; KEEP="${2:-14}"
mkdir -p "$OUT"
F="$OUT/hub-$(date +%Y%m%d-%H%M%S).dump"
docker compose exec -T postgres pg_dump -U hub -d hub -Fc > "$F.part"
[ -s "$F.part" ] || { rm -f "$F.part"; echo "dump rỗng" >&2; exit 1; }
docker compose exec -T postgres pg_restore --list < "$F.part" > /dev/null || { rm -f "$F.part"; echo "dump không hợp lệ" >&2; exit 1; }
mv "$F.part" "$F"
ls -1 "$OUT"/hub-*.dump | sort -r | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "OK $F ($(wc -c < "$F") byte)"
