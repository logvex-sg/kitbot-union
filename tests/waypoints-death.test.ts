import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WaypointService } from '../apps/agent/src/waypoints/service.js';
import { DeathService } from '../apps/agent/src/death/service.js';
import { AgentEventEmitter } from '../apps/agent/src/events.js';
import { createLogger, type AgentEvent, type WaypointType } from '@unionkitbot/shared';
import type { EventRepository } from '@unionkitbot/database';

const logger = createLogger({ name: 'test', level: 'silent' });

interface WaypointRow {
  id: string;
  name: string;
  type: string;
  server: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  botId: string | null;
  playerId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * In-memory stand-in that implements exactly the repository contract used by the services.
 * It exercises the real service logic without requiring a live PostgreSQL instance.
 */
class MemoryWaypointRepository {
  readonly rows: WaypointRow[] = [];

  async create(input: {
    name: string;
    type: WaypointType;
    server: string;
    dimension: string;
    x: number;
    y: number;
    z: number;
    botId?: string | null;
    playerId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<WaypointRow> {
    const row: WaypointRow = {
      id: randomUUID(),
      name: input.name,
      type: input.type,
      server: input.server,
      dimension: input.dimension,
      x: input.x,
      y: input.y,
      z: input.z,
      botId: input.botId ?? null,
      playerId: input.playerId ?? null,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async list(
    filter: { type?: string; search?: string; limit?: number } = {},
  ): Promise<WaypointRow[]> {
    let rows = [...this.rows];
    if (filter.type) rows = rows.filter((r) => r.type === filter.type);
    if (filter.search)
      rows = rows.filter((r) => r.name.toLowerCase().includes(filter.search!.toLowerCase()));
    return rows.slice(0, filter.limit ?? 100);
  }

  async update(id: string, patch: Partial<WaypointRow>): Promise<WaypointRow | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index < 0) return false;
    this.rows.splice(index, 1);
    return true;
  }
}

class MemoryEventRepository {
  readonly deaths: Array<Record<string, unknown>> = [];
  readonly tpa: Array<Record<string, unknown>> = [];
  readonly chat: Array<Record<string, unknown>> = [];
  readonly system: Array<Record<string, unknown>> = [];
  readonly auditEntries: Array<Record<string, unknown>> = [];

  async recordDeath(input: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    this.deaths.push({ ...input, id, createdAt: new Date().toISOString(), recovered: false });
    return id;
  }
  async markDeathRecovered(id: string): Promise<void> {
    const row = this.deaths.find((d) => d['id'] === id);
    if (row) row['recovered'] = true;
  }
  async recordTpaEvent(botId: string, decision: Record<string, unknown>): Promise<void> {
    this.tpa.push({ botId, ...decision, createdAt: new Date().toISOString() });
  }
  async recordChatEvent(input: Record<string, unknown>): Promise<void> {
    this.chat.push(input);
  }
  async recordSystemEvent(input: Record<string, unknown>): Promise<void> {
    this.system.push(input);
  }
  async audit(entry: Record<string, unknown>): Promise<void> {
    this.auditEntries.push(entry);
  }
}

describe('waypoint persistence', () => {
  const build = () => {
    const events = new AgentEventEmitter();
    const captured: AgentEvent[] = [];
    events.on('bot:waypoint', (event) => captured.push(event));
    const repository = new MemoryWaypointRepository();
    const service = new WaypointService({
      botId: 'bot-1',
      server: 'play.example.com:25565',
      logger,
      events,
      repository: repository as never,
    });
    return { service, repository, captured };
  };

  it('creates a waypoint with all required fields and emits an event', async () => {
    const { service, captured } = build();
    const waypoint = await service.create({
      name: 'kit drop',
      type: 'DELIVERY',
      dimension: 'overworld',
      x: 10.5,
      y: 64,
      z: -30,
      metadata: { recipient: 'steve' },
    });
    expect(waypoint.type).toBe('DELIVERY');
    expect(waypoint.server).toBe('play.example.com:25565');
    expect(waypoint.dimension).toBe('overworld');
    expect(waypoint.x).toBe(10.5);
    expect(waypoint.botId).toBe('bot-1');
    expect(waypoint.metadata).toEqual({ recipient: 'steve' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe('bot:waypoint');
  });

  it('filters by type and search, and supports update/delete', async () => {
    const { service } = build();
    const a = await service.create({
      name: 'home base',
      type: 'BASE',
      dimension: 'overworld',
      x: 0,
      y: 64,
      z: 0,
    });
    await service.create({
      name: 'death 1',
      type: 'DEATH',
      dimension: 'overworld',
      x: 5,
      y: 40,
      z: 5,
    });

    expect((await service.list({ type: 'BASE' })).map((w) => w.name)).toEqual(['home base']);
    expect((await service.list({ search: 'death' })).map((w) => w.name)).toEqual(['death 1']);

    const updated = await service.update(a.id, { name: 'renamed base' });
    expect(updated?.name).toBe('renamed base');
    expect(await service.delete(a.id)).toBe(true);
    expect(await service.delete(a.id)).toBe(false);
  });

  it('finds nearby waypoints by coordinate tolerance', async () => {
    const { service } = build();
    await service.create({
      name: 'chest cluster',
      type: 'STORAGE',
      dimension: 'overworld',
      x: 100,
      y: 64,
      z: 100,
    });
    const nearby = await service.nearby('STORAGE', 101, 64.5, 99.5, 4);
    expect(nearby).toHaveLength(1);
    expect(await service.nearby('STORAGE', 200, 64, 200, 4)).toHaveLength(0);
  });
});

describe('death logging', () => {
  const build = (activeTaskId: string | null = 'task-1') => {
    const events = new AgentEventEmitter();
    const captured: AgentEvent[] = [];
    events.on('bot:death', (event) => captured.push(event));
    const eventsRepository = new MemoryEventRepository();
    const waypointsRepository = new MemoryWaypointRepository();
    const waypoints = new WaypointService({
      botId: 'bot-1',
      server: 'play.example.com:25565',
      logger,
      events,
      repository: waypointsRepository as never,
    });
    const death = new DeathService({
      botId: 'bot-1',
      username: 'UnionKitBot',
      logger,
      events,
      eventsRepository: eventsRepository as unknown as EventRepository,
      waypoints,
      getDimension: () => 'the_nether',
      getActiveTaskId: () => activeTaskId,
    });
    return { death, eventsRepository, waypointsRepository, captured };
  };

  it('records coordinates, dimension, active task and creates a DEATH waypoint', async () => {
    const { death, eventsRepository, waypointsRepository, captured } = build('task-42');
    const record = await death.recordDeath({ x: 12.5, y: 70, z: -8 }, 'slain by Zombie');

    expect(record.dimension).toBe('the_nether');
    expect(record.activeTaskId).toBe('task-42');
    expect(record.taskToRestore).toBe('task-42');
    expect(record.waypointId).not.toBeNull();

    const deathRow = eventsRepository.deaths[0]!;
    expect(deathRow['x']).toBe(12.5);
    expect(deathRow['z']).toBe(-8);
    expect(deathRow['cause']).toBe('slain by Zombie');
    expect(deathRow['botId']).toBe('bot-1');

    expect(waypointsRepository.rows).toHaveLength(1);
    expect(waypointsRepository.rows[0]?.type).toBe('DEATH');
    expect(waypointsRepository.rows[0]?.x).toBe(12.5);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.severity).toBe('error');
  });

  it('records a death without coordinates rather than inventing a position', async () => {
    const { death, eventsRepository, waypointsRepository } = build(null);
    const record = await death.recordDeath(null, 'unknown cause');
    expect(record.position).toBeNull();
    expect(record.waypointId).toBeNull();
    expect(waypointsRepository.rows).toHaveLength(0);
    expect(eventsRepository.deaths[0]?.['x']).toBeNull();
  });

  it('marks a death as recovered after the recovery task completes', async () => {
    const { death, eventsRepository } = build();
    const record = await death.recordDeath({ x: 1, y: 2, z: 3 }, 'lava');
    await death.markRecovered(record.deathEventId);
    expect(eventsRepository.deaths[0]?.['recovered']).toBe(true);
  });
});
