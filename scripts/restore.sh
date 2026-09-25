#!/usr/bin/env bash
# Restore a UnionKitBot PostgreSQL backup produced by scripts/backup.sh.
#
# Usage:
#   ./scripts/restore.sh backups/unionkitbot-20260101T031500Z.dump.gz
#
# The stack should be up. This drops and recreates the schema, so it is intentionally
# explicit about the target database before doing anything destructive.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -ne 1 ]; then
  echo "usage: $0 <backup.dump.gz>" >&2
  exit 2
fi

ARCHIVE="$1"
if [ ! -f "$ARCHIVE" ]; then
  echo "[restore] no such file: $ARCHIVE" >&2
  exit 2
fi

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a && . ./.env && set +a
fi

: "${POSTGRES_USER:=unionkitbot}"
: "${POSTGRES_DB:=unionkitbot}"

echo "[restore] target database: $POSTGRES_DB (user $POSTGRES_USER)"
read -r -p "[restore] this will overwrite existing data. type the database name to confirm: " CONFIRM
if [ "$CONFIRM" != "$POSTGRES_DB" ]; then
  echo "[restore] aborted"
  exit 1
fi

TMP="$(mktemp -t unionkitbot-restore-XXXXXX.dump)"
trap 'rm -f "$TMP"' EXIT

case "$ARCHIVE" in
  *.gz) gzip -dc "$ARCHIVE" > "$TMP" ;;
  *)    cp "$ARCHIVE" "$TMP" ;;
esac

echo "[restore] stopping api and agent so nothing writes during the restore"
docker compose stop api agent discord >/dev/null

echo "[restore] restoring"
docker compose exec -T postgres pg_restore \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges < "$TMP"

echo "[restore] restarting services"
docker compose start api agent discord >/dev/null

echo "[restore] done"
