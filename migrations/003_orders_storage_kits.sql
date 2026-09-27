
-- 003: chest sign kit recognition, orders, account links, webhooks, delivery attempts,
-- navigation failures and power-saving state.
--
-- Additive only: no column is dropped or retyped, and every new column on an existing
-- table has a default, so an existing deployment migrates without data loss.

-- --------------------------------------------------------------- kits: aliases
ALTER TABLE kits ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';
-- Explicit operator override of automatic sign detection.
ALTER TABLE kits ADD COLUMN IF NOT EXISTS storage_auto_detect BOOLEAN NOT NULL DEFAULT TRUE;

-- ------------------------------------------------------- storage containers: kit link
ALTER TABLE storage_containers ADD COLUMN IF NOT EXISTS sign_lines TEXT[];
ALTER TABLE storage_containers ADD COLUMN IF NOT EXISTS sign_normalized TEXT;
ALTER TABLE storage_containers ADD COLUMN IF NOT EXISTS detected_kit_id TEXT REFERENCES kits(id) ON DELETE SET NULL;
ALTER TABLE storage_containers ADD COLUMN IF NOT EXISTS match_ambiguous BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE storage_containers ADD COLUMN IF NOT EXISTS match_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_storage_containers_detected_kit ON storage_containers(detected_kit_id);

-- --------------------------------------------------------- kit storage mappings
-- One durable row per recognised storage location, independent of the scan that found it.
CREATE TABLE IF NOT EXISTS kit_storage_mappings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id            UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  server            TEXT NOT NULL,
  dimension         TEXT NOT NULL DEFAULT 'overworld',
  group_key         TEXT NOT NULL,
  kind              TEXT NOT NULL,
  block_name        TEXT NOT NULL,
  x                 DOUBLE PRECISION NOT NULL,
  y                 DOUBLE PRECISION NOT NULL,
  z                 DOUBLE PRECISION NOT NULL,
  sign_lines        TEXT[],
  sign_normalized   TEXT,
  detected_kit_id   TEXT REFERENCES kits(id) ON DELETE SET NULL,
  match_ambiguous   BOOLEAN NOT NULL DEFAULT FALSE,
  match_reason      TEXT,
  -- Manual override wins over detection while override_enabled is true.
  override_kit_id   TEXT REFERENCES kits(id) ON DELETE SET NULL,
  override_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  override_by       TEXT,
  override_at       TIMESTAMPTZ,
  scan_id           UUID REFERENCES storage_scans(id) ON DELETE SET NULL,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bot_id, dimension, group_key)
);
CREATE INDEX IF NOT EXISTS idx_kit_storage_mappings_bot ON kit_storage_mappings(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kit_storage_mappings_kit ON kit_storage_mappings(detected_kit_id);
CREATE INDEX IF NOT EXISTS idx_kit_storage_mappings_override ON kit_storage_mappings(override_kit_id);

-- --------------------------------------------------------------- storage scans
ALTER TABLE storage_scans ADD COLUMN IF NOT EXISTS signs_found INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_scans ADD COLUMN IF NOT EXISTS kits_recognised INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_scans ADD COLUMN IF NOT EXISTS triggered_by TEXT NOT NULL DEFAULT 'manual';

-- ------------------------------------------------------------------- orders
CREATE TABLE IF NOT EXISTS orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id            UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  -- Short numeric code operators type, scoped per bot. Assigned by the API.
  code              INTEGER NOT NULL,
  kit_ids           TEXT[] NOT NULL DEFAULT '{}',
  state             TEXT NOT NULL DEFAULT 'ORDER_RECEIVED',
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','FAILED','CANCELLED')),
  recipient_username TEXT,
  recipient_uuid    UUID,
  discord_user_id   TEXT,
  requested_by      TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'api'
                    CHECK (source IN ('discord','api','chat','cli')),
  task_id           UUID REFERENCES tasks(id) ON DELETE SET NULL,
  delivery_id       UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  error             TEXT,
  state_history     JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bot_id, code)
);
CREATE INDEX IF NOT EXISTS idx_orders_bot_created ON orders(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_discord_user ON orders(discord_user_id);

CREATE TABLE IF NOT EXISTS order_items (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id  UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item      TEXT NOT NULL,
  count     INTEGER NOT NULL CHECK (count > 0),
  UNIQUE (order_id, item)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- A reservation is the durable claim that stops two orders consuming the same items.
CREATE TABLE IF NOT EXISTS order_reservations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  bot_id       UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  item         TEXT NOT NULL,
  count        INTEGER NOT NULL CHECK (count > 0),
  state        TEXT NOT NULL DEFAULT 'HELD'
               CHECK (state IN ('HELD','RELEASED','CONSUMED')),
  released_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, item)
);
CREATE INDEX IF NOT EXISTS idx_order_reservations_bot_state ON order_reservations(bot_id, state);
CREATE INDEX IF NOT EXISTS idx_order_reservations_order ON order_reservations(order_id);

-- ------------------------------------------------------------- account links
CREATE TABLE IF NOT EXISTS account_links (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id     TEXT NOT NULL,
  minecraft_username  TEXT NOT NULL,
  minecraft_uuid      UUID,
  verified            BOOLEAN NOT NULL DEFAULT FALSE,
  method              TEXT NOT NULL DEFAULT 'command'
                      CHECK (method IN ('command','operator','import')),
  linked_by           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One Minecraft account may only be linked to one Discord user. This is the invariant that
-- stops a user claiming someone else's account, so it is enforced in the database.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_links_username_unique
  ON account_links (lower(minecraft_username));
-- Whether one Discord user may hold several accounts is configurable
-- (LINK_ALLOW_MULTIPLE), so that side is enforced in application code, not by an index.
CREATE INDEX IF NOT EXISTS idx_account_links_discord ON account_links(discord_user_id);

-- ------------------------------------------------------ delivery attempts (TPA)
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID REFERENCES orders(id) ON DELETE CASCADE,
  delivery_id       UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  bot_id            UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  attempt           INTEGER NOT NULL DEFAULT 1,
  recipient         TEXT NOT NULL,
  phase             TEXT NOT NULL,
  tpa_command       TEXT,
  tpa_outcome       TEXT CHECK (tpa_outcome IN ('PENDING','ACCEPTED','REJECTED','EXPIRED','TIMEOUT')),
  teleport_wait_ms  INTEGER,
  drop_range        DOUBLE PRECISION,
  items             JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified          BOOLEAN NOT NULL DEFAULT FALSE,
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_order ON delivery_attempts(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_delivery ON delivery_attempts(delivery_id);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_bot ON delivery_attempts(bot_id, created_at DESC);

-- ------------------------------------------------------ navigation failures
CREATE TABLE IF NOT EXISTS navigation_failures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
  task_id       UUID REFERENCES tasks(id) ON DELETE SET NULL,
  label         TEXT NOT NULL,
  reason        TEXT NOT NULL,
  replans       INTEGER NOT NULL DEFAULT 0,
  elapsed_ms    INTEGER NOT NULL DEFAULT 0,
  dimension     TEXT,
  from_x        DOUBLE PRECISION,
  from_y        DOUBLE PRECISION,
  from_z        DOUBLE PRECISION,
  to_x          DOUBLE PRECISION,
  to_y          DOUBLE PRECISION,
  to_z          DOUBLE PRECISION,
  stuck         BOOLEAN NOT NULL DEFAULT FALSE,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_navigation_failures_bot ON navigation_failures(bot_id, created_at DESC);

-- --------------------------------------------------- death events: extra context
ALTER TABLE death_events ADD COLUMN IF NOT EXISTS bot_state TEXT;
ALTER TABLE death_events ADD COLUMN IF NOT EXISTS server TEXT;
ALTER TABLE death_events ADD COLUMN IF NOT EXISTS active_order_id UUID REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_death_events_order ON death_events(active_order_id);

-- ------------------------------------------------------------- webhook config
CREATE TABLE IF NOT EXISTS webhook_config (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL UNIQUE,
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  url                   TEXT,
  events                TEXT[] NOT NULL DEFAULT '{}',
  retry_count           INTEGER NOT NULL DEFAULT 2 CHECK (retry_count >= 0 AND retry_count <= 10),
  timeout_ms            INTEGER NOT NULL DEFAULT 5000 CHECK (timeout_ms >= 500),
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 30 CHECK (rate_limit_per_minute > 0),
  include_payload       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id   UUID NOT NULL REFERENCES webhook_config(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('DELIVERED','FAILED','RATE_LIMITED','SKIPPED')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  status_code  INTEGER,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_kind ON webhook_deliveries(kind, created_at DESC);

-- ------------------------------------------------------- power saving state
CREATE TABLE IF NOT EXISTS power_saving_state (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id                      UUID NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE UNIQUE,
  enabled                     BOOLEAN NOT NULL DEFAULT TRUE,
  idle_scan_interval_seconds  INTEGER NOT NULL DEFAULT 30,
  idle_telemetry_interval_seconds INTEGER NOT NULL DEFAULT 15,
  aggressive                  BOOLEAN NOT NULL DEFAULT FALSE,
  throttled                   BOOLEAN NOT NULL DEFAULT FALSE,
  last_reason                 TEXT,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
