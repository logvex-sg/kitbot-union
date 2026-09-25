
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS bot_instances (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  minecraft_uuid UUID,
  server_host   TEXT NOT NULL,
  server_port   INTEGER NOT NULL DEFAULT 25565,
  server_version TEXT,
  auth_type     TEXT NOT NULL DEFAULT 'offline' CHECK (auth_type IN ('offline','microsoft')),
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  auto_connect  BOOLEAN NOT NULL DEFAULT TRUE,
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bot_instances_enabled ON bot_instances(enabled);

CREATE TABLE IF NOT EXISTS bot_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id         UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  state          TEXT NOT NULL,
  server_host    TEXT NOT NULL,
  dimension      TEXT,
  x              DOUBLE PRECISION,
  y              DOUBLE PRECISION,
  z              DOUBLE PRECISION,
  health         REAL,
  food           REAL,
  reconnect_count INTEGER NOT NULL DEFAULT 0,
  connected_at   TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  disconnect_reason TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bot_sessions_bot_created ON bot_sessions(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS players (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  minecraft_uuid UUID UNIQUE,
  username       TEXT NOT NULL UNIQUE,
  discord_id     TEXT,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS idx_players_discord_id ON players(discord_id);

CREATE TABLE IF NOT EXISTS player_permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  granted_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, permission)
);

CREATE TABLE IF NOT EXISTS kits (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kit_items (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kit_id    TEXT NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
  item      TEXT NOT NULL,
  count     INTEGER NOT NULL CHECK (count > 0),
  UNIQUE (kit_id, item)
);
CREATE INDEX IF NOT EXISTS idx_kit_items_kit ON kit_items(kit_id);

CREATE TABLE IF NOT EXISTS tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID REFERENCES bot_instances(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  priority      TEXT NOT NULL CHECK (priority IN ('CRITICAL','HIGH','NORMAL','LOW')),
  status        TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','PAUSED','COMPLETED','FAILED','CANCELLED')),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  resume_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  result        JSONB,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_bot ON tasks(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deliveries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID REFERENCES tasks(id) ON DELETE SET NULL,
  bot_id         UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  recipient      TEXT NOT NULL,
  recipient_uuid UUID,
  kit_ids        TEXT[] NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','FAILED','CANCELLED')),
  current_step   TEXT,
  destination    JSONB,
  verified       BOOLEAN NOT NULL DEFAULT FALSE,
  verification   JSONB,
  result         JSONB,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deliveries_bot_created ON deliveries(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);

CREATE TABLE IF NOT EXISTS waypoints (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('DELIVERY','DEATH','STORAGE','TARGET','BASE','CUSTOM')),
  server      TEXT NOT NULL,
  dimension   TEXT NOT NULL DEFAULT 'overworld',
  x           DOUBLE PRECISION NOT NULL,
  y           DOUBLE PRECISION NOT NULL,
  z           DOUBLE PRECISION NOT NULL,
  bot_id      UUID REFERENCES bot_instances(id) ON DELETE SET NULL,
  player_id   UUID REFERENCES players(id) ON DELETE SET NULL,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_waypoints_type ON waypoints(type);
CREATE INDEX IF NOT EXISTS idx_waypoints_server ON waypoints(server, dimension);
CREATE INDEX IF NOT EXISTS idx_waypoints_created ON waypoints(created_at DESC);

CREATE TABLE IF NOT EXISTS death_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  player_id     UUID REFERENCES players(id) ON DELETE SET NULL,
  dimension     TEXT,
  x             DOUBLE PRECISION,
  y             DOUBLE PRECISION,
  z             DOUBLE PRECISION,
  cause         TEXT,
  active_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  waypoint_id   UUID REFERENCES waypoints(id) ON DELETE SET NULL,
  recovered     BOOLEAN NOT NULL DEFAULT FALSE,
  recovered_at  TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_death_events_bot ON death_events(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS storage_scans (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id                 UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  delivery_id            UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  dimension              TEXT NOT NULL,
  origin_x               DOUBLE PRECISION NOT NULL,
  origin_y               DOUBLE PRECISION NOT NULL,
  origin_z               DOUBLE PRECISION NOT NULL,
  radius                 DOUBLE PRECISION NOT NULL,
  logical_container_count INTEGER NOT NULL DEFAULT 0,
  counts                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  inspected              INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_storage_scans_bot_created ON storage_scans(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS storage_containers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id    UUID NOT NULL REFERENCES storage_scans(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  block_name TEXT NOT NULL,
  group_key  TEXT NOT NULL,
  x          DOUBLE PRECISION NOT NULL,
  y          DOUBLE PRECISION NOT NULL,
  z          DOUBLE PRECISION NOT NULL,
  contents   JSONB
);
CREATE INDEX IF NOT EXISTS idx_storage_containers_scan ON storage_containers(scan_id);
CREATE INDEX IF NOT EXISTS idx_storage_containers_group ON storage_containers(scan_id, group_key);

CREATE TABLE IF NOT EXISTS chat_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id     UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  raw        TEXT NOT NULL,
  event_type TEXT NOT NULL,
  player     TEXT,
  message    TEXT,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_events_bot_created ON chat_events(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_events_type ON chat_events(event_type);

CREATE TABLE IF NOT EXISTS tpa_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  request_id    TEXT NOT NULL,
  player        TEXT NOT NULL,
  player_uuid   UUID,
  mode          TEXT NOT NULL,
  accepted      BOOLEAN NOT NULL,
  reason        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpa_events_bot_created ON tpa_events(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tpa_events_player ON tpa_events(player);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor);

CREATE TABLE IF NOT EXISTS system_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info',
  bot_id     UUID REFERENCES bot_instances(id) ON DELETE SET NULL,
  message    TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_system_events_created ON system_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_severity ON system_events(severity);
