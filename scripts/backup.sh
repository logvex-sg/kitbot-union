#!/usr/bin/env bash
# UnionKitBot PostgreSQL backup.
#
# Usage:
#   ./scripts/backup.sh [output-dir]        # default: ./backups
#
# Safe to run from cron. Example nightly backup at 03:15, keeping 14 days:
#   15 3 * * * cd /opt/unionkitbot && ./scripts/backup.sh /var/backups/unionkitbot >> /var/log/unionkitbot-backup.log 2>&1
#   find /var/backups/unionkitbot -name '*.dump' -mtime +14 -delete
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="${1:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$OUT_DIR"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a && . ./.env && set +a
fi

: "${POSTGRES_USER:=unionkitbot}"
: "${POSTGRES_DB:=unionkitbot}"

FILE="$OUT_DIR/unionkitbot-$STAMP.dump"

echo "[backup] dumping $POSTGRES_DB to $FILE"
docker compose exec -T postgres pg_dump \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --format custom \
  --no-owner \
  --no-privileges > "$FILE"

gzip -f "$FILE"
FINAL="$FILE.gz"
SIZE="$(du -h "$FINAL" | cut -f1)"
echo "[backup] wrote $FINAL ($SIZE)"

echo "[backup] pruning backups older than ${RETENTION_DAYS} days"
find "$OUT_DIR" -name 'unionkitbot-*.dump.gz' -mtime "+$RETENTION_DAYS" -print -delete

echo "[backup] done"
