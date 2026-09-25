# UnionKitBot — agent notes

pnpm monorepo. Apps: `api`, `agent`, `discord`, `ui`. Packages: `shared`, `schemas`,
`config`, `database`. PostgreSQL is the source of truth; Redis holds ephemeral state.

## Commands

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm build
pnpm test                 # integration tests skip unless TEST_DATABASE_URL/TEST_REDIS_URL are set
pnpm db:migrate           # needs DATABASE_URL; runs migrations/*.sql
pnpm format               # prettier --write
```

The agent also runs migrations on boot, so `db:migrate` is only needed to apply schema
without starting a bot.

## Docker

```bash
docker compose up -d --build                 # postgres, redis, api, agent, ui
docker compose --profile discord up -d       # adds the Discord controller (needs credentials)
```

Only `ui` publishes host ports (default 8080) and reverse-proxies `/api` to the API
container, so browsers talk to one origin. `discord` is behind a profile because it
cannot start without `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` / `DISCORD_GUILD_ID` and
would otherwise restart-loop.

## Invariants worth knowing

- **Discord has no direct write path to Minecraft.** Every Discord command goes through
  `AgentClient` (control socket) → `apps/agent/src/control-server.ts` → `CommandRouter`.
  The originating surface travels as `source` and lands in `audit_logs`.
- **The agent reloads bot definitions lazily.** A bot created via the API exists in
  Postgres before the agent knows about it; `CommandRouter.resolveOrReload` re-reads
  `bot_instances` on a lookup miss. `BotRegistry.register` is idempotent, so existing
  runtimes are never replaced.
- **On a fresh database the agent boots with zero bots by design** (`bots:0`). Create the
  first bot through the API/UI, then start it.
- **Redis bot state is TTL'd and heartbeat-refreshed.** `live: null` on `GET /api/bots`
  means no heartbeat landed within the TTL, not necessarily that the bot is stopped.
- **`GET /api/bots` returns camelCase**; repository mappers must not leak snake_case rows.
- Reconnect uses exponential backoff with jitter, clamped by `settings.reconnect`
  (`backoffDelay` in `packages/shared/src/retry.ts`).

## Testing notes

`tests/integration.test.ts` needs a migrated database. Quick local infra:

```bash
docker run -d --name ukb-pg-t -e POSTGRES_USER=unionkitbot -e POSTGRES_PASSWORD=testpw \
  -e POSTGRES_DB=unionkitbot -p 55432:5432 postgres:16-alpine
docker run -d --name ukb-redis-t -p 56379:6379 redis:7-alpine
DATABASE_URL=postgres://unionkitbot:testpw@127.0.0.1:55432/unionkitbot pnpm db:migrate
TEST_DATABASE_URL=postgres://unionkitbot:testpw@127.0.0.1:55432/unionkitbot \
  TEST_REDIS_URL=redis://127.0.0.1:56379 pnpm test
```

## Environment

pnpm comes from corepack; `export COREPACK_ENABLE_DOWNLOAD_PROMPT=0` avoids an
interactive prompt. In sandboxed environments corepack shims live at
`/acp-node/lib/node_modules/corepack/shims`.
