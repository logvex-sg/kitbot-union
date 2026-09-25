import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@unionkitbot/shared';
import { loadConfig, ConfigError } from '@unionkitbot/config';
import {
  createPool,
  getPool,
  createRepositories,
  RedisState,
  runMigrations,
} from '@unionkitbot/database';
import { AgentEventEmitter } from './events.js';
import { BotRegistry } from './registry.js';
import { CommandRouter } from './commands.js';
import { ControlServer } from './control-server.js';
import { seedBotsFromFile } from './config-seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = process.env.UKB_MIGRATIONS_DIR ?? path.resolve(here, '../../../migrations');

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      // Print which variables are wrong without leaking any secret values.
      console.error(`configuration error: ${error.issues.join('; ')}`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ name: 'agent', level: config.LOG_LEVEL });
  const events = new AgentEventEmitter();

  const pool = getPool({ connectionString: config.DATABASE_URL, logger });
  createPool({ connectionString: config.DATABASE_URL, logger });

  const migrationResult = await runMigrations(pool, migrationsDir, logger);
  logger.info(
    { applied: migrationResult.applied.length, skipped: migrationResult.skipped.length },
    'migrations ready',
  );

  const repositories = createRepositories(pool);
  const redis = RedisState.fromUrl(config.REDIS_URL, logger);

  const registry = new BotRegistry({
    logger,
    events,
    repositories,
    redis,
    defaults: config.defaultAgentSettings,
    heartbeatMs: config.AGENT_HEARTBEAT_MS,
  });

  const router = new CommandRouter(registry, async (entry) => {
    await repositories.events
      .audit(entry)
      .catch((error: unknown) => logger.debug({ err: error }, 'audit failed'));
  });

  // Persist every notable runtime event for the Logs/Events pages and Discord relay.
  events.on('*', (event) => {
    void redis.publishEvent(event).catch(() => undefined);
    if (event.severity === 'error' || event.severity === 'critical') {
      void repositories.events
        .recordSystemEvent({
          type: event.type,
          severity: event.severity,
          botId: event.botId,
          message: event.message,
          data: (event.data ?? {}) as Record<string, unknown>,
        })
        .catch(() => undefined);
    }
    if (event.type === 'bot:chat') {
      const data = event.data as { eventType?: string; player?: string | null } | undefined;
      if (event.botId && data?.eventType) {
        void repositories.events
          .recordChatEvent({
            botId: event.botId,
            raw: event.message,
            eventType: data.eventType,
            player: data.player ?? null,
            message: event.message,
            metadata: (event.data ?? {}) as Record<string, unknown>,
          })
          .catch(() => undefined);
      }
    }
  });

  // The JSON file at MC_CONFIG_PATH is an onboarding convenience; PostgreSQL stays authoritative.
  try {
    const seeded = await seedBotsFromFile(config.MC_CONFIG_PATH, repositories, logger);
    if (seeded.created || seeded.updated) {
      logger.info(seeded, 'bot config file applied');
    }
  } catch (error: unknown) {
    logger.error(
      { err: error, path: config.MC_CONFIG_PATH },
      'bot config file could not be applied; continuing with the database state',
    );
  }

  const loaded = await registry.loadFromDatabase();
  if (loaded.length === 0) {
    logger.warn('no bots configured; create one via the API or seed the database');
  }

  const control = new ControlServer({
    logger,
    registry,
    router,
    events,
    port: Number(process.env.AGENT_CONTROL_PORT ?? 8090),
    host: process.env.AGENT_CONTROL_HOST ?? '0.0.0.0',
    secret: config.API_SECRET,
  });

  await registry.startAll();
  logger.info({ bots: registry.size }, 'UnionKitBot agent started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down agent');
    await registry.stopAll(signal).catch(() => undefined);
    await control.close().catch(() => undefined);
    await redis.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('agent failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
