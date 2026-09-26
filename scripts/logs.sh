#!/usr/bin/env bash
# Log management for the UnionKitBot stack.
#
#   ./scripts/logs.sh follow api        # tail the api container
#   ./scripts/logs.sh errors            # only error-level lines from all services
#   ./scripts/logs.sh docker-prune      # reclaim space used by rotated container logs
#   ./scripts/logs.sh journal-vacuum 200M
set -euo pipefail

cd "$(dirname "$0")/.."

ACTION="${1:-help}"

case "$ACTION" in
  follow)
    SERVICE="${2:-api}"
    docker compose logs -f --tail=200 "$SERVICE"
    ;;

  errors)
    # Filters the combined stream for error and critical severity lines.
    docker compose logs --tail=2000 --no-color \
      | grep -iE '"(level|severity)":"(error|critical|fatal)"|error:|\bERROR\b' \
      || echo "[logs] no error lines in the last 2000 entries"
    ;;

  docker-prune)
    echo "[logs] container log usage before:"
    docker system df
    # Container logs are capped by the compose logging options (10m x 5 files per service).
    docker system prune -f --filter "until=168h"
    echo "[logs] container log usage after:"
    docker system df
    ;;

  journal-vacuum)
    SIZE="${2:-200M}"
    echo "[logs] limiting the systemd journal to $SIZE"
    if [ "$(id -u)" -eq 0 ]; then
      journalctl --vacuum-size="$SIZE"
    else
      sudo journalctl --vacuum-size="$SIZE"
    fi
    ;;

  help|*)
    cat <<'USAGE'
UnionKitBot log management

  ./scripts/logs.sh follow [service]     tail a service (default: api)
  ./scripts/logs.sh errors               show error-level lines across the stack
  ./scripts/logs.sh docker-prune         reclaim disk from old containers/images
  ./scripts/logs.sh journal-vacuum [size] limit systemd journal growth (default 200M)

Per-service container logs are already capped at 10 MB x 5 files by docker-compose.yml.
USAGE
    ;;
esac
