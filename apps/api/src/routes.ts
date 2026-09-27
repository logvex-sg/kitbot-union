import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  accountLinkQuerySchema,
  botSettingsSchema,
  createAccountLinkSchema,
  createBotSchema,
  createOrderSchema,
  createStorageScanSchema,
  createTaskSchema,
  createWaypointSchema,
  deathHistoryQuerySchema,
  kitSchema,
  navigationFailureQuerySchema,
  orderCodeParamsSchema,
  orderListQuerySchema,
  paginationSchema,
  storageMappingQuerySchema,
  updateBotSchema,
  updateKitSchema,
  updateStorageMappingSchema,
  updateWaypointSchema,
  webhookConfigSchema,
  webhookConfigUpdateSchema,
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

/** Bot by explicit id, else the first configured bot. */
async function resolveBot(
  deps: RouteDeps,
  botId?: string,
): Promise<{ id: string; name: string } | null> {
  if (botId) {
    const bot = await deps.repositories.bots.get(botId);
    return bot ? { id: bot.id, name: bot.name } : null;
  }
  const bots = await deps.repositories.bots.list();
  const first = bots[0];
  return first ? { id: first.id, name: first.name } : null;
}

/**
 * Resolves the Minecraft recipient for an order.
 *
 * An explicit username wins; otherwise the Discord link is consulted so a caller only needs
 * the Discord user id. Resolution failure is returned as null so the caller can answer 400
 * instead of queueing an order that could never be delivered.
 */
async function resolveOrderRecipient(
  deps: RouteDeps,
  input: { recipient?: string; discordUserId?: string },
): Promise<string | null> {
  if (input.recipient) return input.recipient;
  if (!input.discordUserId) return null;
  const link = await deps.repositories.accountLinks.forDiscordUser(input.discordUserId);
  return link[0]?.minecraftUsername ?? null;
}

/**
 * Webhook URLs embed a secret token in the path, so the raw value is replaced by the
 * repository's redacted form before leaving the API.
 */
function redactWebhookConfig<T extends { url: string | null; redactedUrl: string | null }>(config: T) {
  return { ...config, url: config.redactedUrl };
}

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

  app.post(
    '/api/storage/scans',
    { preHandler: auth },
    async (request, reply) => {
      const input = parse(createStorageScanSchema, request.body);
      const bot = await resolveBot(deps, input.botId);
      if (!bot) return reply.code(404).send({ error: 'not_found', message: 'bot not found' });
      const result = await deps.agent.send(
        'enqueue',
        [
          'STORAGE_SCAN',
          'LOW',
          JSON.stringify({
            ...(input.origin ? { origin: input.origin } : {}),
            ...(input.radius !== undefined ? { radius: input.radius } : {}),
            updateMappings: input.updateMappings,
            triggeredBy: input.triggeredBy,
          }),
        ],
        bot.name,
      );
      return reply.code(result.ok ? 201 : 502).send(result);
    },
  );

  // ------------------------------------------------------------------ storage mappings

  app.get('/api/storage/mappings', { preHandler: auth }, async (request) => {
    const query = parse(storageMappingQuerySchema, request.query);
    const mappings = await deps.repositories.storageMappings.list({
      ...(query.botId ? { botId: query.botId } : {}),
      ...(query.kitId ? { kitId: query.kitId } : {}),
      ...(query.dimension ? { dimension: query.dimension } : {}),
      unresolvedOnly: query.unresolvedOnly,
      limit: query.limit,
      offset: query.offset,
    });
    return { mappings };
  });

  app.patch('/api/storage/mappings/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const input = parse(updateStorageMappingSchema, request.body);
    const existing = await deps.repositories.storageMappings.get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found', message: 'mapping not found' });
    const updated = await deps.repositories.storageMappings.setOverride(
      id,
      input.kitId ?? null,
      'api',
      input.overrideEnabled ?? input.kitId !== undefined,
    );
    await deps.repositories.events.audit({
      actor: 'api',
      action: 'storage.mapping.override',
      targetType: 'storage_mapping',
      targetId: id,
      detail: { kitId: input.kitId ?? null, enabled: input.overrideEnabled ?? null },
    });
    return { mapping: updated };
  });

  // ------------------------------------------------------------------ orders

  app.get('/api/orders', { preHandler: auth }, async (request) => {
    const query = parse(orderListQuerySchema, request.query);
    const orders = await deps.repositories.orders.list({
      ...(query.botId ? { botId: query.botId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.recipient ? { recipient: query.recipient } : {}),
      limit: query.limit,
      offset: query.offset,
    });
    return { orders };
  });

  app.post('/api/orders', { preHandler: auth }, async (request, reply) => {
    const input = parse(createOrderSchema, request.body);
    const bot = await resolveBot(deps, input.botId);
    if (!bot) return reply.code(404).send({ error: 'not_found', message: 'bot not found' });
    const recipient = await resolveOrderRecipient(deps, input);
    if (!recipient) {
      return reply
        .code(400)
        .send({ error: 'invalid_recipient', message: 'recipient could not be resolved' });
    }
    const result = await deps.agent.send(
      'order',
      [recipient, ...input.kitIds],
      bot.name,
    );
    await deps.repositories.events.audit({
      actor: input.requestedBy,
      action: 'order.create',
      targetType: 'bot',
      targetId: bot.id,
      detail: { kitIds: input.kitIds, recipient, source: input.source },
    });
    return reply.code(result.ok ? 201 : 502).send(result);
  });

  app.get('/api/orders/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const order = await deps.repositories.orders.get(id);
    if (!order) return reply.code(404).send({ error: 'not_found', message: 'order not found' });
    const [items, reservations] = await Promise.all([
      deps.repositories.orders.items(id),
      deps.repositories.orders.reservations(id),
    ]);
    return { order, items, reservations };
  });

  app.post('/api/orders/code/:code/cancel', { preHandler: auth }, async (request, reply) => {
    const { code } = parse(orderCodeParamsSchema, request.params);
    const queried = parse(
      z.object({ botId: z.string().uuid().optional() }),
      request.query,
    );
    const bot = await resolveBot(deps, queried.botId);
    if (!bot) return reply.code(404).send({ error: 'not_found', message: 'bot not found' });
    const order = await deps.repositories.orders.getByCode(bot.id, code);
    if (!order) return reply.code(404).send({ error: 'not_found', message: 'order not found' });
    const result = await deps.agent.send('cancelorder', [String(code)], bot.name);
    await deps.repositories.events.audit({
      actor: 'api',
      action: 'order.cancel',
      targetType: 'order',
      targetId: order.id,
      detail: { code },
    });
    return result;
  });

  app.get('/api/orders/:id/attempts', { preHandler: auth }, async (request) => {
    const { id } = parse(idParams, request.params);
    const attempts = await deps.repositories.orders.listAttempts({ orderId: id });
    return { attempts };
  });

  // ------------------------------------------------------------------ account links

  app.get('/api/account-links', { preHandler: auth }, async (request) => {
    const query = parse(accountLinkQuerySchema, request.query);
    const links = await deps.repositories.accountLinks.list({
      ...(query.discordUserId ? { discordUserId: query.discordUserId } : {}),
      ...(query.minecraftUsername ? { minecraftUsername: query.minecraftUsername } : {}),
      ...(query.verified !== undefined ? { verified: query.verified } : {}),
      limit: query.limit,
      offset: query.offset,
    });
    return { links };
  });

  app.post('/api/account-links', { preHandler: auth }, async (request, reply) => {
    const input = parse(createAccountLinkSchema, request.body);
    const result = await deps.repositories.accountLinks.link({
      discordUserId: input.discordUserId,
      minecraftUsername: input.minecraftUsername,
      method: input.method,
      ...(input.linkedBy ? { linkedBy: input.linkedBy } : {}),
      ...(input.verified !== undefined ? { forceVerified: input.verified } : {}),
    });
    if (!result.ok) {
      return reply
        .code(result.code === 'conflict' ? 409 : 400)
        .send({ error: result.code, message: result.reason });
    }
    await deps.repositories.events.audit({
      actor: input.linkedBy ?? 'api',
      action: 'account.link',
      targetType: 'account_link',
      targetId: input.discordUserId,
      detail: { minecraftUsername: input.minecraftUsername, method: input.method },
    });
    return reply.code(201).send({ link: result.link, action: result.action });
  });

  app.delete('/api/account-links/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const removed = await deps.repositories.accountLinks.unlink(id);
    if (!removed) return reply.code(404).send({ error: 'not_found', message: 'link not found' });
    return { ok: true };
  });

  // ------------------------------------------------------------------ webhooks

  app.get('/api/webhooks', { preHandler: auth }, async () => {
    const configs = await deps.repositories.webhooks.list();
    return { webhooks: configs.map(redactWebhookConfig) };
  });

  app.get('/api/webhooks/:name', { preHandler: auth }, async (request, reply) => {
    const { name } = parse(z.object({ name: z.string().min(1).max(64) }), request.params);
    const config = await deps.repositories.webhooks.getByName(name);
    if (!config) return reply.code(404).send({ error: 'not_found', message: 'webhook not found' });
    const deliveries = await deps.repositories.webhooks.listDeliveries({
      webhookId: config.id,
      limit: 20,
    });
    return { webhook: redactWebhookConfig(config), deliveries };
  });

  app.put('/api/webhooks', { preHandler: auth }, async (request, reply) => {
    const input = parse(webhookConfigSchema, request.body);
    const config = await deps.repositories.webhooks.upsert({
      name: input.name,
      enabled: input.enabled,
      url: input.url ?? null,
      events: input.events,
      retryCount: input.retryCount,
      timeoutMs: input.timeoutMs,
      rateLimitPerMinute: input.rateLimitPerMinute,
      includePayload: input.includePayload,
    });
    await deps.repositories.events.audit({
      actor: 'api',
      action: 'webhook.upsert',
      targetType: 'webhook',
      targetId: input.name,
      detail: { enabled: input.enabled, events: input.events },
    });
    return reply.code(201).send({ webhook: redactWebhookConfig(config) });
  });

  app.patch('/api/webhooks/:name', { preHandler: auth }, async (request, reply) => {
    const { name } = parse(z.object({ name: z.string().min(1).max(64) }), request.params);
    const input = parse(webhookConfigUpdateSchema, request.body);
    const existing = await deps.repositories.webhooks.getByName(name);
    if (!existing) return reply.code(404).send({ error: 'not_found', message: 'webhook not found' });
    const updated = await deps.repositories.webhooks.update(name, {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.events !== undefined ? { events: input.events } : {}),
      ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.rateLimitPerMinute !== undefined
        ? { rateLimitPerMinute: input.rateLimitPerMinute }
        : {}),
      ...(input.includePayload !== undefined ? { includePayload: input.includePayload } : {}),
    });
    return { webhook: updated ? redactWebhookConfig(updated) : null };
  });

  app.get('/api/webhooks/:name/deliveries', { preHandler: auth }, async (request, reply) => {
    const { name } = parse(z.object({ name: z.string().min(1).max(64) }), request.params);
    const query = parse(paginationSchema, request.query);
    const config = await deps.repositories.webhooks.getByName(name);
    if (!config) return reply.code(404).send({ error: 'not_found', message: 'webhook not found' });
    const deliveries = await deps.repositories.webhooks.listDeliveries({
      webhookId: config.id,
      limit: query.limit,
      offset: query.offset,
    });
    const summary = await deps.repositories.webhooks.deliverySummary();
    return { deliveries, summary };
  });

  // ------------------------------------------------------------------ deaths

  app.get('/api/deaths', { preHandler: auth }, async (request) => {
    const query = parse(deathHistoryQuerySchema, request.query);
    const deaths = await deps.repositories.events.listDeaths({
      ...(query.botId ? { botId: query.botId } : {}),
      ...(query.recovered !== undefined ? { recovered: query.recovered } : {}),
      limit: query.limit,
      offset: query.offset,
    });
    return { deaths };
  });

  // ------------------------------------------------------------------ deliveries

  app.get('/api/navigation/failures', { preHandler: auth }, async (request) => {
    const query = parse(navigationFailureQuerySchema, request.query);
    const failures = await deps.repositories.orders.listNavigationFailures({
      ...(query.botId ? { botId: query.botId } : {}),
      stuckOnly: query.stuckOnly,
      limit: query.limit,
      offset: query.offset,
    });
    return { failures };
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
        'order',
        'orders',
        'cancelorder',
        'mappings',
        'setmapping',
        'webhook',
      ],
    };
  });

  app.get('/api/live', { preHandler: auth }, async () => {
    return { events: deps.hub.recentEvents(200) };
  });
}
