#!/usr/bin/env bash
# Runs the UnionKitBot database migrations against a live PostgreSQL instance.
#
#   ./scripts/migrate.sh                 # uses DATABASE_URL from .env
#   DATABASE_URL=postgres://... ./scripts/migrate.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a && . ./.env && set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  : "${POSTGRES_USER:=unionkitbot}"
  : "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD or DATABASE_URL}"
  : "${POSTGRES_DB:=unionkitbot}"
  echo "[migrate] no DATABASE_URL set; running inside the postgres container instead"
  for file in migrations/*.sql; do
    echo "[migrate] applying $file"
    docker compose exec -T postgres psql \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      --set ON_ERROR_STOP=1 < "$file"
  done
  echo "[migrate] done"
  exit 0
fi

export PATH="$HOME/.local/bin:$PATH"
pnpm --filter @unionkitbot/database migrate
