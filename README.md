# UnionKitBot

Autonomous Minecraft kit-delivery bot for a Linux VPS (Debian/Ubuntu). TypeScript
pnpm monorepo: a Mineflayer agent, a Fastify API with WebSockets, a discord.js
controller, and an original dark operator UI (`unionkitbot.ui`).

The bot connects to a configured server, reconnects on its own, parses chat,
applies TPA rules, navigates with `mineflayer-pathfinder`, delivers kits, verifies
delivery against real inventory state, scans storage, and persists every event.
PostgreSQL is the source of truth; Redis holds ephemeral state and locks.

## Quick start (Docker)

```bash
cp .env.example .env      # set POSTGRES_PASSWORD and API_SECRET at minimum
docker compose up -d --build
```

Open `http://<vps-ip>:${UI_PORT:-8080}/` and paste `API_SECRET` into the connect
screen. Only the `ui` service publishes host ports; `postgres`, `redis`, `api`
and `agent` stay on the internal network.

Services: `postgres`, `redis`, `api`, `agent`, `ui`.

The `discord` controller is opt-in because it needs Discord credentials. Enable it
with the profile, after setting `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and
`DISCORD_GUILD_ID` in `.env`:

```bash
docker compose --profile discord up -d
```

Then create a bot and start it. On a fresh database the agent boots with zero bots
by design, so the first bot must be created through the API or UI:

```bash
curl -X POST http://<vps-ip>:8080/api/bots \
  -H "Authorization: Bearer $API_SECRET" -H 'Content-Type: application/json' \
  -d '{"name":"mc-01","username":"UnionKitBot","serverHost":"mc.example.net","serverPort":25565,"authType":"offline"}'

# The response contains the bot id. Lifecycle routes take that UUID, not the name.
BOT_ID=$(curl -s http://<vps-ip>:8080/api/bots -H "Authorization: Bearer $API_SECRET" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['bots'][0]['id'])")

curl -X POST "http://<vps-ip>:8080/api/bots/$BOT_ID/start" \
  -H "Authorization: Bearer $API_SECRET"
```

`/api/bots/:id` and the lifecycle routes validate a UUID; use `/api/bots` to look the
id up by name. Commands routed to the agent may name a bot instead, which is what the
Discord controller does.

The agent re-reads `bot_instances` when a command names a bot it has not loaded yet,
so a bot created after startup can be started without restarting the agent.

## Local development

```bash
corepack enable && corepack prepare pnpm@10.34.5 --activate
pnpm install
pnpm build
pnpm dev:api        # Fastify API + WebSocket
pnpm dev:agent      # Mineflayer agent
pnpm dev:ui         # Vite dev server for unionkitbot.ui
pnpm dev:discord    # discord.js controller
```

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test           # 148 tests
pnpm build
```

Integration tests need real infrastructure and are skipped without it:

```bash
docker run -d --name ukb-pg-test -e POSTGRES_PASSWORD=testpw \
  -e POSTGRES_USER=unionkitbot -e POSTGRES_DB=unionkitbot -p 55432:5432 \
  -v "$PWD/migrations:/docker-entrypoint-initdb.d:ro" postgres:18-alpine
docker run -d --name ukb-redis-test -p 56379:6379 redis:8-alpine

TEST_DATABASE_URL=postgres://unionkitbot:testpw@127.0.0.1:55432/unionkitbot \
TEST_REDIS_URL=redis://127.0.0.1:56379 pnpm test
```

## Architecture

```
apps/api      Fastify REST + WebSocket hub, Zod validation, auth, rate limiting
apps/agent    Mineflayer bot: state machine, task queue, navigation, delivery
apps/discord  discord.js slash commands, routed through the agent CommandRouter
apps/ui       React + Vite, unionkitbot.ui
packages/shared     domain types, state machine, chat parsing, storage logic
packages/schemas    Zod request/response contracts
packages/database   PostgreSQL repositories, Redis state, migrations
packages/config     env parsing and validation
migrations    SQL schema (UUIDs, foreign keys, indexes)
docker        Dockerfiles and nginx configs
scripts       migrate, backup, restore, deploy, logs
```

The bot runs an explicit state machine — `OFFLINE`, `CONNECTING`, `SPAWNING`,
`IDLE`, `NAVIGATING`, `DELIVERING`, `SCANNING`, `RECOVERING`, `DISCONNECTED`,
`DEAD`, `ERROR` — driven by an `OBSERVE → DECIDE → ACT → VERIFY` loop over a
priority task queue (CRITICAL connection/death recovery, HIGH TPA, NORMAL
delivery/navigation, LOW scans and telemetry). Tasks are pausable and resume
across restarts.

Discord commands never write to Minecraft directly; they are handed to the agent
`CommandRouter` so the agent remains the single write path.

## API

```
GET  /api/health
GET  /api/bots                    GET  /api/bots/:id
POST /api/bots/:id/start          POST /api/bots/:id/stop
POST /api/bots/:id/restart
GET  /api/tasks                   POST /api/tasks
POST /api/tasks/:id/cancel
GET  /api/deliveries
GET  /api/waypoints               POST /api/waypoints
DELETE /api/waypoints/:id
GET  /api/storage/scans
GET  /api/events                  GET  /api/logs
WS   /api/ws?token=<API_SECRET>
```

Kits use `GET /api/kits`, `PUT /api/kits/:id` (create or replace),
`PATCH /api/kits/:id`, `DELETE /api/kits/:id`.

All REST and WebSocket traffic is authenticated. `API_SECRET` is accepted as
`Authorization: Bearer <secret>` or `x-api-key: <secret>`; the WebSocket takes it
as the `token` query parameter because browsers cannot set WS headers.

A kit is a named item list:

```json
{
  "id": "starter",
  "name": "Starter kit",
  "enabled": true,
  "items": [
    { "item": "minecraft:bread", "count": 32 },
    { "item": "minecraft:iron_pickaxe", "count": 1 }
  ]
}
```

## HTTPS

`docker/nginx-tls.conf` plus `docker-compose.override.tls.yml` add a TLS front end:

```bash
apt install certbot
certbot certonly --standalone -d bot.example.com
cp /etc/letsencrypt/live/bot.example.com/fullchain.pem docker/certs/
cp /etc/letsencrypt/live/bot.example.com/privkey.pem  docker/certs/
docker compose -f docker-compose.yml -f docker-compose.override.tls.yml up -d
```

Certificates live in `docker/certs` and are never committed.

## Backups and logs

```bash
./scripts/backup.sh /var/backups/unionkitbot      # pg_dump, safe from cron
./scripts/restore.sh /var/backups/unionkitbot/<file>.dump
./scripts/logs.sh api                             # tail service logs
```

Suggested nightly cron (03:15, 14-day retention):

```
15 3 * * * cd /opt/unionkitbot && ./scripts/backup.sh /var/backups/unionkitbot >> /var/log/unionkitbot-backup.log 2>&1
find /var/backups/unionkitbot -name '*.dump' -mtime +14 -delete
```

Container logs use the `json-file` driver with rotation configured on the compose
services. Set `LOG_LEVEL` (default `info`) to control verbosity.

## Configuration

All configuration is environment based; see `.env.example`. Never commit `.env`.
Relevant groups: PostgreSQL and Redis URLs, `API_SECRET`, Minecraft connection and
auth (`MC_AUTH_TYPE`, offline by default; use a legitimate Microsoft account for
online-mode servers), Discord token and allow-lists, the optional LLM classifier
(`LLM_CLASSIFIER_ENABLED`, off by default), and the UI bind/port/accent.

The optional LLM classifier only ever labels ambiguous chat. Its output passes
through deterministic validation before it can cause any Minecraft action.

## Scope

This is gameplay automation for an anarchy server: automated movement, chat,
inventory, TPA handling, pathfinding, container interaction, reconnecting and
multiple bot instances. It does not steal credentials or sessions, does not attack
server infrastructure, and does not implement anti-cheat bypasses or evasion.
