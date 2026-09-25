#!/usr/bin/env bash
# UnionKitBot VPS bootstrap and deployment helper for Debian/Ubuntu.
#
#   ./scripts/deploy.sh            # install docker if needed, validate .env, build and start
#   ./scripts/deploy.sh --update   # pull, rebuild, restart with health verification
#
# The script never prints secret values from .env.
set -euo pipefail

cd "$(dirname "$0")/.."

log() { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

require_root_or_sudo() {
  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    die "need root or sudo to install packages"
  fi
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "docker already installed"
  else
    log "installing docker engine and compose plugin"
    require_root_or_sudo
    as_root apt-get update -y
    as_root apt-get install -y ca-certificates curl gnupg
    as_root install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/"$(. /etc/os-release && echo "$ID")"/gpg \
      | as_root gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    as_root chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      | as_root tee /etc/apt/sources.list.d/docker.list >/dev/null
    as_root apt-get update -y
    as_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    as_root systemctl enable --now docker
    if [ -n "${SUDO_USER:-}" ]; then
      as_root usermod -aG docker "$SUDO_USER" || true
      warn "added $SUDO_USER to the docker group; log out and back in for it to take effect"
    fi
  fi
  docker compose version >/dev/null 2>&1 || die "docker compose plugin is required"
}

validate_env() {
  [ -f .env ] || die "missing .env (copy .env.example and fill it in)"
  # shellcheck disable=SC1091
  set -a && . ./.env && set +a

  local missing=0
  for key in POSTGRES_PASSWORD API_SECRET; do
    if [ -z "${!key:-}" ] || [[ "${!key}" == change-me* ]]; then
      warn "$key is unset or still the example value"
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || die "fix the values above in .env before deploying"

  if [ "${#API_SECRET}" -lt 16 ]; then
    die "API_SECRET must be at least 16 characters"
  fi
  log "environment looks valid"
}

wait_for_health() {
  local url="http://127.0.0.1:${UI_PORT:-8080}/healthz"
  log "waiting for $url"
  for _ in $(seq 1 30); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "reverse proxy is serving traffic"
      return 0
    fi
    sleep 2
  done
  warn "health check did not pass; recent logs follow"
  docker compose logs --tail=40 api agent
  return 1
}

main() {
  install_docker
  validate_env

  if [ "${1:-}" = "--update" ]; then
    log "pulling latest source"
    git pull --ff-only
  fi

  log "building images"
  docker compose build

  log "starting stack"
  docker compose up -d

  log "service status"
  docker compose ps

  wait_for_health || warn "stack is up but not yet healthy; inspect: docker compose logs -f api"
  log "UI: http://127.0.0.1:${UI_PORT:-8080}"
}

main "$@"
