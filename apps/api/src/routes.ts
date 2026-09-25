import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  botSettingsSchema,
  createBotSchema,
  createTaskSchema,
  createWaypointSchema,
  kitSchema,
  paginationSchema,
  updateBotSchema,
  updateKitSchema,
  updateWaypointSchema,
} from '@unionkitbot/schemas';
import { ValidationError } from '@unionkitbot/shared';
import type { Repositories, RedisState } from '@unionkitbot/database';
import type { AuthService } from './auth.js';
import type { AgentClient } from '@unionkitbot/shared';
import type { EventHub } from './ws.js';

export interface RouteDeps {
  repositories: Repositories;
  redis: RedisState;
  auth: AuthService;
  agent: AgentClient;
  hub: EventHub;
  startedAt: number;
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError('request validation failed', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

const idParams = z.object({ id: z.string().uuid() });
const kitIdParams = z.object({ id: z.string().min(1).max(64) });

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const auth = deps.auth.requireAuth;

  app.get('/api/health', async () => {
    const [db, redis] = await Promise.all([
      deps.repositories.bots
        .list()
        .then(() => ({ ok: true }))
        .catch(() => ({ ok: false })),
      deps.redis.ping(),
    ]);
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      status: 'ok',
      uptimeMs: Date.now() - deps.startedAt,
      database: db.ok ? 'up' : 'down',
      redis: redis.ok ? 'up' : 'down',
      agent: deps.agent.connected ? 'up' : 'down',
      wsClients: await deps.redis.wsClientCount(),
      process: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
      },
      timestamp: new Date().toISOString(),
    };
  });

  // ------------------------------------------------------------------ bots

  app.get('/api/bots', { preHandler: auth }, async () => {
    const bots = await deps.repositories.bots.list();
    const enriched = await Promise.all(
      bots.map(async (bot) => ({
        ...bot,
        live: await deps.redis.getBotState<Record<string, unknown>>(bot.id),
      })),
    );
    return { bots: enriched };
  });

  app.get('/api/bots/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const bot = await deps.repositories.bots.get(id);
    if (!bot) return reply.code(404).send({ error: 'not_found', message: 'bot not found' });
    const [live, session] = await Promise.all([
      deps.redis.getBotState<Record<string, unknown>>(id),
      deps.repositories.sessions.latestForBot(id),
    ]);
    return { bot, live, session };
  });

  app.post('/api/bots', { preHandler: auth }, async (request, reply) => {
    const input = parse(createBotSchema, request.body);
    const existing = await deps.repositories.bots.getByName(input.name);
    if (existing) {
      return reply
        .code(409)
        .send({ error: 'conflict', message: `bot ${input.name} already exists` });
    }
    const bot = await deps.repositories.bots.create({
      name: input.name,
      username: input.username,
      serverHost: input.serverHost,
      serverPort: input.serverPort,
      serverVersion: input.serverVersion ?? null,
      authType: input.authType,
      enabled: input.enabled,
      autoConnect: input.autoConnect,
      settings: input.settings,
    });
    await deps.repositories.events.audit({
      actor: 'api',
      action: 'bot.create',
      targetType: 'bot',
      targetId: bot.id,
      detail: { name: bot.name },
    });
    return reply.code(201).send({ bot });
  });

  app.patch('/api/bots/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const patch = parse(updateBotSchema, request.body);
    const bot = await deps.repositories.bots.update(id, {
      ...(patch.username !== undefined ? { username: patch.username } : {}),
      ...(patch.serverHost !== undefined ? { serverHost: patch.serverHost } : {}),
      ...(patch.serverPort !== undefined ? { serverPort: patch.serverPort } : {}),
      ...(patch.serverVersion !== undefined ? { serverVersion: patch.serverVersion } : {}),
      ...(patch.authType !== undefined ? { authType: patch.authType } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.autoConnect !== undefined ? { autoConnect: patch.autoConnect } : {}),
      ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
    });
    if (!bot) return reply.code(404).send({ error: 'not_found', message: 'bot not found' });
    await deps.repositories.events.audit({
      actor: 'api',
      action: 'bot.update',
      targetType: 'bot',
      targetId: id,
      detail: { fields: Object.keys(patch) },
    });
    // Connection settings are baked into the live runtime, so ask the agent to rebuild it.
    // Best-effort: the edit is already durable and applies on next agent start regardless.
    const reload = await deps.agent
      .send('reload', [], bot.name)
      .catch(() => ({ ok: false, message: 'agent unreachable' }));
    return { bot, reload };
  });

  app.post('/api/bots/:id/settings', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const patch = parse(botSettingsSchema, request.body);
    const bot = await deps.repositories.bots.get(id);
    if (!bot) return reply.code(404).send({ error: 'not_found', message: 'bot not found' });
    const merged = { ...bot.settings, ...patch };
    const updated = await deps.repositories.bots.update(id, { settings: merged });
    await deps.repositories.events.audit({
      actor: 'api',
      action: 'bot.settings.update',
      targetType: 'bot',
      targetId: id,
      detail: { keys: Object.keys(patch) },
    });
    return { bot: updated, settings: merged };
  });

  const botControl =
    (action: 'start' | 'stop' | 'restart', command: string) =>
    async (
      request: { params: unknown },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const { id } = parse(idParams, request.params);
      const bot = await deps.repositories.bots.get(id);
      if (!bot) return reply.code(404).send({ error: 'not_found', message: 'bot not found' });
      return deps.agent.send(command, [], bot.name);
    };

  app.post('/api/bots/:id/start', { preHandler: auth }, botControl('start', 'start') as never);
  app.post('/api/bots/:id/stop', { preHandler: auth }, botControl('stop', 'stop') as never);
  app.post(
    '/api/bots/:id/restart',
    { preHandler: auth },
    botControl('restart', 'restart') as never,
  );

  app.post('/api/bots/:id/command', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const body = parse(
      z.object({
        command: z.string().min(1).max(64),
        args: z.array(z.string().max(256)).default([]),
      }),
      request.body,
    );
    const bot = await deps.repositories.bots.get(id);
    if (!bot) return reply.code(404).send({ error: 'not_found', message: 'bot not found' });
    return deps.agent.send(body.command, body.args, bot.name);
  });

  // ------------------------------------------------------------------ tasks

  app.get('/api/tasks', { preHandler: auth }, async (request) => {
    const query = parse(
      paginationSchema.extend({
        botId: z.string().uuid().optional(),
        status: z.string().optional(),
      }),
      request.query,
    );
    const tasks = await deps.repositories.tasks.list({
      ...(query.botId ? { botId: query.botId } : {}),
      ...(query.status ? { status: query.status } : {}),
      limit: query.limit,
      offset: query.offset,
    });
    return { tasks };
  });

  app.post('/api/tasks', { preHandler: auth }, async (request, reply) => {
    const input = parse(createTaskSchema, request.body);
    const bot = await deps.repositories.bots.get(input.botId);
    if (!bot) return reply.code(404).send({ error: 'not_found', message: 'bot not found' });
    const priority = input.priority ?? 'NORMAL';
    const result = await deps.agent.send(
      'enqueue',
      [input.type, priority, JSON.stringify(input.payload)],
      bot.name,
    );
    await deps.repositories.events.audit({
      actor: 'api',
      action: 'task.create',
      targetType: 'bot',
      targetId: bot.id,
      detail: { type: input.type, priority },
    });
    return reply.code(result.ok ? 201 : 502).send(result);
  });

  const taskAction =
    (command: string) =>
    async (
      request: { params: unknown },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const { id } = parse(idParams, request.params);
      const task = await deps.repositories.tasks.get(id);
      if (!task) return reply.code(404).send({ error: 'not_found', message: 'task not found' });
      const result = await deps.agent.send(command, [id], task.botId ?? undefined);
      if (command === 'canceltask') {
        await deps.repositories.tasks
          .recordEvent(id, 'cancelled', { via: 'api' })
          .catch(() => undefined);
      }
      return result;
    };

  app.post('/api/tasks/:id/cancel', { preHandler: auth }, taskAction('canceltask') as never);
  app.post('/api/tasks/:id/pause', { preHandler: auth }, taskAction('pausetask') as never);
  app.post('/api/tasks/:id/resume', { preHandler: auth }, taskAction('resumetask') as never);

  // ------------------------------------------------------------------ deliveries

  app.get('/api/deliveries', { preHandler: auth }, async (request) => {
    const query = parse(
      paginationSchema.extend({
        botId: z.string().uuid().optional(),
        status: z.string().optional(),
      }),
      request.query,
    );
    const deliveries = await deps.repositories.deliveries.list({
      ...(query.botId ? { botId: query.botId } : {}),
      ...(query.status ? { status: query.status } : {}),
      limit: query.limit,
      offset: query.offset,
    });
    return { deliveries };
  });

  // ------------------------------------------------------------------ kits

  app.get('/api/kits', { preHandler: auth }, async () => {
    const kits = await deps.repositories.kits.list();
    return { kits };
  });

  app.put('/api/kits/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(kitIdParams, request.params);
    const input = parse(kitSchema, { ...(request.body as object), id });
    const kit = await deps.repositories.kits.upsert(input);
    await deps.repositories.events.audit({
      actor: 'api',
      action: 'kit.upsert',
      targetType: 'kit',
      targetId: id,
      detail: { items: input.items.length },
    });
    return reply.code(200).send({ kit });
  });

  app.patch('/api/kits/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(kitIdParams, request.params);
    const patch = parse(updateKitSchema, request.body);
    const existing = await deps.repositories.kits.get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found', message: 'kit not found' });
    const kit = await deps.repositories.kits.upsert({ ...existing, ...patch, id });
    return { kit };
  });

  app.delete('/api/kits/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(kitIdParams, request.params);
    const deleted = await deps.repositories.kits.delete(id);
    if (!deleted) return reply.code(404).send({ error: 'not_found', message: 'kit not found' });
    return { ok: true };
  });

  // ------------------------------------------------------------------ waypoints

  app.get('/api/waypoints', { preHandler: auth }, async (request) => {
    const query = parse(
      z.object({
        type: z.string().optional(),
        server: z.string().optional(),
        botId: z.string().uuid().optional(),
        search: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
    );
    const waypoints = await deps.repositories.waypoints.list(query);
    return { waypoints };
  });

  app.post('/api/waypoints', { preHandler: auth }, async (request, reply) => {
    const input = parse(createWaypointSchema, request.body);
    const waypoint = await deps.repositories.waypoints.create({
      name: input.name,
      type: input.type,
      server: input.server,
      dimension: input.dimension,
      x: input.x,
      y: input.y,
      z: input.z,
      botId: input.botId ?? null,
      playerId: input.playerId ?? null,
      metadata: input.metadata,
    });
    await deps.repositories.events.audit({
      actor: 'api',
      action: 'waypoint.create',
      targetType: 'waypoint',
      targetId: waypoint.id,
      detail: { type: input.type },
    });
    return reply.code(201).send({ waypoint });
  });

  app.patch('/api/waypoints/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const patch = parse(updateWaypointSchema, request.body);
    const waypoint = await deps.repositories.waypoints.update(id, patch as never);
    if (!waypoint)
      return reply.code(404).send({ error: 'not_found', message: 'waypoint not found' });
    return { waypoint };
  });

  app.delete('/api/waypoints/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const deleted = await deps.repositories.waypoints.delete(id);
    if (!deleted)
      return reply.code(404).send({ error: 'not_found', message: 'waypoint not found' });
    await deps.repositories.events.audit({
      actor: 'api',
      action: 'waypoint.delete',
      targetType: 'waypoint',
      targetId: id,
      detail: {},
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ storage

  app.get('/api/storage/scans', { preHandler: auth }, async (request) => {
    const query = parse(
      paginationSchema.extend({ botId: z.string().uuid().optional() }),
      request.query,
    );
    const scans = await deps.repositories.storage.listScans(query);
    return { scans };
  });

  // ------------------------------------------------------------------ events/logs

  app.get('/api/events', { preHandler: auth }, async (request) => {
    const query = parse(
      paginationSchema.extend({
        botId: z.string().uuid().optional(),
        severity: z.enum(['info', 'warn', 'error', 'critical']).optional(),
      }),
      request.query,
    );
    const [events, deaths, tpa] = await Promise.all([
      deps.repositories.events.listSystemEvents(query),
      deps.repositories.events.listDeaths({ limit: query.limit, offset: query.offset }),
      deps.repositories.events.listTpaEvents({ limit: query.limit, offset: query.offset }),
    ]);
    return { events, deaths, tpa };
  });

  app.get('/api/logs', { preHandler: auth }, async (request) => {
    const query = parse(
      paginationSchema.extend({ botId: z.string().uuid().optional() }),
      request.query,
    );
    const [systemEvents, audit] = await Promise.all([
      deps.repositories.events.listSystemEvents(query),
      deps.repositories.events.listAudit({ limit: query.limit, offset: query.offset }),
    ]);
    return { logs: systemEvents, audit };
  });

  app.get('/api/chat', { preHandler: auth }, async (request) => {
    const query = parse(
      paginationSchema.extend({
        botId: z.string().uuid().optional(),
        eventType: z.string().optional(),
      }),
      request.query,
    );
    const chat = await deps.repositories.events.listChatEvents(query);
    return { chat, recent: deps.hub.recentEvents(200) };
  });

  // ------------------------------------------------------------------ players/sessions

  app.get('/api/players', { preHandler: auth }, async (request) => {
    const query = parse(paginationSchema, request.query);
    const players = await deps.repositories.players.list(query.limit);
    return { players };
  });

  app.get('/api/sessions', { preHandler: auth }, async (request) => {
    const query = parse(paginationSchema, request.query);
    const sessions = await deps.repositories.sessions.list(query.limit);
    return { sessions };
  });

  app.get('/api/discord', { preHandler: auth }, async () => {
    return {
      configured: Boolean(process.env.DISCORD_TOKEN),
      guildId: process.env.DISCORD_GUILD_ID ?? null,
      notifyChannelId: process.env.DISCORD_NOTIFY_CHANNEL_ID ?? null,
      commands: [
        'status',
        'start',
        'stop',
        'restart',
        'goto',
        'follow',
        'inventory',
        'players',
        'tasks',
        'deliveries',
        'waypoints',
        'logs',
        'chat',
        'deliver',
      ],
    };
  });

  app.get('/api/live', { preHandler: auth }, async () => {
    return { events: deps.hub.recentEvents(200) };
  });
}
