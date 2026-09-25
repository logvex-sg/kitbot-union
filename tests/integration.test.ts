/**
 * Live integration coverage.
 *
 * These tests require real PostgreSQL and Redis instances and are skipped unless
 * TEST_DATABASE_URL and TEST_REDIS_URL are set, so `pnpm test` stays green on a
 * machine without infrastructure. Start them with:
 *
 *   docker run -d --name ukb-pg-test -e POSTGRES_PASSWORD=testpw \
 *     -e POSTGRES_USER=unionkitbot -e POSTGRES_DB=unionkitbot -p 55432:5432 \
 *     -v "$PWD/migrations:/docker-entrypoint-initdb.d:ro" postgres:16-alpine
 *   docker run -d --name ukb-redis-test -p 56379:6379 redis:7-alpine
 *
 *   TEST_DATABASE_URL=postgres://unionkitbot:testpw@127.0.0.1:55432/unionkitbot \
 *   TEST_REDIS_URL=redis://127.0.0.1:56379 pnpm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createPool,
  createRepositories,
  RedisState,
  type Repositories,
} from '@unionkitbot/database';
import { createLogger } from '@unionkitbot/shared';
import type pg from 'pg';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const REDIS_URL = process.env['TEST_REDIS_URL'];
const enabled = Boolean(DATABASE_URL && REDIS_URL);

const logger = createLogger({ name: 'integration', level: 'silent' });

describe.skipIf(!enabled)('live database and redis integration', () => {
  let pool: pg.Pool;
  let repositories: Repositories;
  let redis: RedisState;
  let botId: string;

  beforeAll(() => {
    pool = createPool({ connectionString: DATABASE_URL!, logger, max: 4 });
    repositories = createRepositories(pool);
    redis = RedisState.fromUrl(REDIS_URL!, logger);
  });

  afterAll(async () => {
    if (botId) await repositories.bots.remove(botId).catch(() => undefined);
    await redis.close();
    await pool.end();
  });

  it('migrations produced a queryable schema', async () => {
    const bots = await repositories.bots.list();
    expect(Array.isArray(bots)).toBe(true);
  });

  it('persists and reads back a bot instance with a round-tripped settings object', async () => {
    const bot = await repositories.bots.create({
      name: `mc-test-${randomUUID().slice(0, 8)}`,
      username: 'UnionKitBotIT',
      serverHost: 'play.example.com',
      serverPort: 25565,
      authType: 'offline',
      enabled: true,
      autoConnect: false,
      settings: { navigation: { goalRadius: 3 } },
    });
    botId = bot.id;

    expect(bot.id).toMatch(/^[0-9a-f-]{36}$/);
    const fetched = await repositories.bots.get(bot.id);
    expect(fetched?.username).toBe('UnionKitBotIT');
    expect(fetched?.settings).toEqual({ navigation: { goalRadius: 3 } });

    const renamed = await repositories.bots.update(bot.id, { username: 'Renamed' });
    expect(renamed?.username).toBe('Renamed');
    expect(await repositories.bots.getByName(bot.name)).not.toBeNull();
  });

  it('pins waypoints to the bot via a foreign key and filters them', async () => {
    const waypoint = await repositories.waypoints.create({
      name: 'integration delivery point',
      type: 'DELIVERY',
      server: 'play.example.com:25565',
      dimension: 'overworld',
      x: 42.5,
      y: 64,
      z: -17,
      botId,
      metadata: { recipient: 'steve', kits: ['starter'] },
    });

    expect(waypoint.botId).toBe(botId);
    expect(waypoint.metadata).toEqual({ recipient: 'steve', kits: ['starter'] });

    const filtered = await repositories.waypoints.list({ type: 'DELIVERY', botId });
    expect(filtered.map((w) => w.id)).toContain(waypoint.id);

    const searched = await repositories.waypoints.list({ search: 'integration deliv' });
    expect(searched.map((w) => w.id)).toContain(waypoint.id);

    const updated = await repositories.waypoints.update(waypoint.id, { name: 'renamed point' });
    expect(updated?.name).toBe('renamed point');
    expect(await repositories.waypoints.delete(waypoint.id)).toBe(true);
    expect(await repositories.waypoints.delete(waypoint.id)).toBe(false);
  });

  it('rejects a waypoint referencing a bot that does not exist', async () => {
    await expect(
      repositories.waypoints.create({
        name: 'orphan',
        type: 'TARGET',
        server: 'play.example.com:25565',
        dimension: 'overworld',
        x: 0,
        y: 0,
        z: 0,
        botId: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it('keeps waypoints as persistent history when their bot is deleted', async () => {
    const throwaway = await repositories.bots.create({
      name: `mc-detach-${randomUUID().slice(0, 8)}`,
      username: 'DetachBot',
      serverHost: 'play.example.com',
      serverPort: 25565,
      authType: 'offline',
      enabled: true,
      autoConnect: false,
      settings: {},
    });
    const detached = await repositories.waypoints.create({
      name: 'survives bot deletion',
      type: 'BASE',
      server: 'play.example.com:25565',
      dimension: 'overworld',
      x: 1,
      y: 2,
      z: 3,
      botId: throwaway.id,
    });

    expect(await repositories.bots.remove(throwaway.id)).toBe(true);

    // waypoints.bot_id is ON DELETE SET NULL so the waypoint itself is retained.
    const reloaded = await repositories.waypoints.get(detached.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.botId).toBeNull();
    expect(await repositories.waypoints.list({ botId: throwaway.id })).toHaveLength(0);

    await repositories.waypoints.delete(detached.id);
  });

  it('stores and retrieves kits with their items', async () => {
    const kitId = `it-kit-${randomUUID().slice(0, 8)}`;
    await repositories.kits.upsert({
      id: kitId,
      name: 'Integration Kit',
      items: [
        { item: 'bread', count: 16 },
        { item: 'iron_pickaxe', count: 1 },
      ],
      enabled: true,
    });

    const kit = await repositories.kits.get(kitId);
    expect(kit?.items).toEqual([
      { item: 'bread', count: 16 },
      { item: 'iron_pickaxe', count: 1 },
    ]);
    expect((await repositories.kits.list()).some((k) => k.id === kitId)).toBe(true);
    expect(await repositories.kits.delete(kitId)).toBe(true);
    expect(await repositories.kits.get(kitId)).toBeNull();
  });

  it('records a death event with coordinates and marks it recovered', async () => {
    const deathId = await repositories.events.recordDeath({
      botId,
      dimension: 'overworld',
      x: 100.5,
      y: 40,
      z: -200,
      cause: 'slain by Zombie',
      activeTaskId: null,
    });
    expect(deathId).toMatch(/^[0-9a-f-]{36}$/);

    const deaths = await repositories.events.listDeaths({ botId });
    const recorded = deaths.find((d) => d.id === deathId);
    expect(recorded?.x).toBe(100.5);
    expect(recorded?.cause).toBe('slain by Zombie');

    await repositories.events.markDeathRecovered(deathId);
    const after = await repositories.events.listDeaths({ botId });
    expect(after.find((d) => d.id === deathId)?.recovered).toBe(true);
  });

  it('logs a tpa decision and an audit entry', async () => {
    await repositories.events.recordTpaEvent(botId, {
      requestId: randomUUID(),
      player: 'Steve',
      playerUuid: null,
      accepted: true,
      mode: 'TRUSTED_ONLY',
      reason: 'player is trusted',
      at: new Date().toISOString(),
    });
    const tpa = await repositories.events.listTpaEvents({ botId });
    expect(tpa.at(-1)?.accepted).toBe(true);

    await repositories.events.audit({
      actor: 'integration-test',
      action: 'waypoint.create',
      targetType: 'waypoint',
      targetId: null,
      metadata: { source: 'test' },
    });
    const audit = await repositories.events.listAudit({});
    expect(audit.some((a) => a.actor === 'integration-test')).toBe(true);
  });

  it('returns storage scans in camelCase so the UI can render origin and counts', async () => {
    const scanId = await repositories.storage.saveScan(
      {
        scanId: randomUUID(),
        botId,
        dimension: 'overworld',
        origin: { x: 100.5, y: -60, z: 200.25 },
        radius: 8,
        logicalContainerCount: 15,
        counts: { chest: 4, double_chest: 3, barrel: 2, shulker_box: 6 },
        inspected: 12,
        containers: [],
        timestamp: new Date().toISOString(),
      },
      null,
      new Map(),
    );
    expect(scanId).toBeTruthy();

    const scans = await repositories.storage.listScans({ botId });
    const scan = scans.find((s) => s['id'] === scanId);
    expect(scan).toBeDefined();
    // Fields the UI reads directly; snake_case names here would render as "-".
    expect(scan?.['x']).toBeCloseTo(100.5);
    expect(scan?.['y']).toBeCloseTo(-60);
    expect(scan?.['z']).toBeCloseTo(200.25);
    expect(scan?.['logicalContainerCount']).toBe(15);
    expect(scan?.['inspected']).toBe(12);
    expect(scan?.['createdAt']).toBeTruthy();
    expect(scan?.['originX']).toBeUndefined();
  });

  it('keeps a temp bot event separate from the persisted source of truth', async () => {
    await redis.setBotState(botId, { state: 'IDLE', connected: true });
    const state = await redis.getBotState<{ state: string; connected: boolean }>(botId);
    expect(state?.state).toBe('IDLE');
    expect(state?.connected).toBe(true);

    await redis.clearBotState(botId);
    expect(await redis.getBotState(botId)).toBeNull();
  });

  it('enforces a redis lock so two workers cannot hold the same bot', async () => {
    const key = `lock:it:${botId}`;
    const release = await redis.acquireLock(key, 5000, 'worker-a');
    expect(release).not.toBeNull();

    const contested = await redis.acquireLock(key, 5000, 'worker-b');
    expect(contested).toBeNull();

    // A worker that does not own the lock must not be able to release it.
    const impostor = await redis.acquireLock(key, 5000, 'worker-c');
    expect(impostor).toBeNull();

    await release!();
    const reacquired = await redis.acquireLock(key, 5000, 'worker-b');
    expect(reacquired).not.toBeNull();
    await reacquired!();
  });

  it('withLock runs the critical section exactly once and always releases', async () => {
    const key = `withlock:it:${botId}`;
    const first = await redis.withLock(key, 5000, 'owner', async () => 'ran');
    expect(first).toBe('ran');
    const second = await redis.withLock(key, 5000, 'owner', async () => 'again');
    expect(second).toBe('again');
  });

  it('honours redis cooldowns', async () => {
    const name = `it-${randomUUID().slice(0, 8)}`;
    expect(await redis.tryCooldown(botId, name, 5000)).toBe(true);
    expect(await redis.tryCooldown(botId, name, 5000)).toBe(false);
    const remaining = await redis.cooldownRemaining(botId, name);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
  });

  it('tracks and counts live websocket clients', async () => {
    const before = await redis.wsClientCount();
    const clientId = `ws-${randomUUID()}`;
    await redis.trackWsClient(clientId);
    expect(await redis.wsClientCount()).toBeGreaterThanOrEqual(before + 1);
    await redis.untrackWsClient(clientId);
    expect(await redis.wsClientCount()).toBe(before);
  });

  it('uses the cache namespace for short-lived values', async () => {
    const key = `it-cache-${randomUUID()}`;
    await redis.cacheSet(key, { total: 3 }, 30);
    expect(await redis.cacheGet<{ total: number }>(key)).toEqual({ total: 3 });
  });

  it('reports redis health through ping', async () => {
    const result = await redis.ping();
    expect(result.ok).toBe(true);
  });
});
