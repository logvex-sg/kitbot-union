import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { createLogger, UnionKitError, type Logger } from '@unionkitbot/shared';
import type { AppConfig } from '@unionkitbot/config';
import { createRepositories, RedisState, getPool, type Repositories } from '@unionkitbot/database';
import { AuthService } from './auth.js';
import { AgentClient } from '@unionkitbot/shared';

import { EventHub } from './ws.js';
import { registerRoutes } from './routes.js';

export interface ServerHandle {
  app: FastifyInstance;
  logger: Logger;
  repositories: Repositories;
  redis: RedisState;
  agent: AgentClient;
  hub: EventHub;
  close: () => Promise<void>;
}

export interface BuildServerOptions {
  config: AppConfig;
  /** Injectable for tests: skips real pool/redis construction. */
  repositories?: Repositories;
  redis?: RedisState;
  agent?: AgentClient;
}

export async function buildServer(options: BuildServerOptions): Promise<ServerHandle> {
  const { config } = options;
  const logger = createLogger({ name: 'api', level: config.LOG_LEVEL });
  const startedAt = Date.now();

  const pool = getPool({ connectionString: config.DATABASE_URL, logger });
  const repositories = options.repositories ?? createRepositories(pool);
  const redis = options.redis ?? RedisState.fromUrl(config.REDIS_URL, logger);

  const auth = new AuthService({
    apiSecret: config.API_SECRET,
    allowedDiscordUsers: config.discordAllowedUsers,
    logger,
    disabled: config.NODE_ENV === 'test',
  });

  const hub = new EventHub({ logger, redis, auth, path: config.WS_PATH });
  const agent =
    options.agent ??
    new AgentClient({
      url: process.env.AGENT_CONTROL_URL ?? 'ws://agent:8090',
      secret: config.API_SECRET,
      logger,
      onEvent: (event) => hub.ingest(event),
    });

  const app = Fastify({
    // Fastify requires `loggerInstance` for an already-constructed pino instance. The cast is
    // needed because pino's Logger type is narrower than Fastify's FastifyBaseLogger.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: false,
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: [],
  });
  await app.register(websocket);

  hub.register(app);
  await registerRoutes(app, {
    repositories,
    redis,
    auth,
    agent,
    hub,
    startedAt,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'request validation failed',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (error instanceof UnionKitError) {
      const status = error.code === 'VALIDATION_ERROR' ? 400 : 500;
      return reply
        .code(status)
        .send({ error: error.code, message: error.message, detail: error.detail });
    }
    const maybeStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof maybeStatus === 'number' ? maybeStatus : 500;
    if (statusCode >= 500) {
      logger.error({ err: error, path: request.url }, 'unhandled error');
      // Never surface internal error text to clients on 5xx responses.
      return reply.code(500).send({ error: 'internal_error', message: 'internal server error' });
    }
    const message = error instanceof Error ? error.message : 'request error';
    return reply.code(statusCode).send({ error: 'request_error', message });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'route not found' }),
  );

  agent.connect();

  return {
    app,
    logger,
    repositories,
    redis,
    agent,
    hub,
    close: async () => {
      agent.close();
      await hub.close();
      await app.close();
      await redis.close();
    },
  };
}
