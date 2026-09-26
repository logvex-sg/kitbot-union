export { createPool, getPool, closePool, ping, type DatabaseOptions } from './pool.js';
export { runMigrations, type MigrationResult } from './migrate.js';
export { jsonb, num, str, iso, isoOrNull, type Row } from './mappers.js';

export { BotRepository, type BotInstanceRow } from './repositories/bots.js';
export { SessionRepository, type BotSessionRow } from './repositories/sessions.js';
export { TaskRepository, taskRowToPriorityTask, type TaskRow } from './repositories/tasks.js';
export { KitRepository } from './repositories/kits.js';
export { WaypointRepository, type WaypointRow } from './repositories/waypoints.js';
export { DeliveryRepository, type DeliveryRow } from './repositories/deliveries.js';
export { StorageRepository } from './repositories/storage.js';
export { EventRepository } from './repositories/events.js';
export { PlayerRepository } from './repositories/players.js';

import type pg from 'pg';
import { BotRepository } from './repositories/bots.js';
import { SessionRepository } from './repositories/sessions.js';
import { TaskRepository } from './repositories/tasks.js';
import { KitRepository } from './repositories/kits.js';
import { WaypointRepository } from './repositories/waypoints.js';
import { DeliveryRepository } from './repositories/deliveries.js';
import { StorageRepository } from './repositories/storage.js';
import { EventRepository } from './repositories/events.js';
import { PlayerRepository } from './repositories/players.js';

export interface Repositories {
  bots: BotRepository;
  sessions: SessionRepository;
  tasks: TaskRepository;
  kits: KitRepository;
  waypoints: WaypointRepository;
  deliveries: DeliveryRepository;
  storage: StorageRepository;
  events: EventRepository;
  players: PlayerRepository;
}

export function createRepositories(pool: pg.Pool): Repositories {
  return {
    bots: new BotRepository(pool),
    sessions: new SessionRepository(pool),
    tasks: new TaskRepository(pool),
    kits: new KitRepository(pool),
    waypoints: new WaypointRepository(pool),
    deliveries: new DeliveryRepository(pool),
    storage: new StorageRepository(pool),
    events: new EventRepository(pool),
    players: new PlayerRepository(pool),
  };
}

export { RedisState, RedisKeys, REDIS_CHANNELS, type RedisOptions } from './redis.js';
