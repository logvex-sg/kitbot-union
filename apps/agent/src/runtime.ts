import type {
  AgentSettings,
  BotRuntimeSnapshot,
  Logger,
  PriorityTask,
  TaskPriority,
  TaskType,
} from '@unionkitbot/shared';
import {
  PRIORITY_WEIGHT,
  PriorityTaskQueue,
  ReservationLedger,
  WriteBehind,
  mergeAgentSettings,
  parseChatEnvelope,
  stripFormatting,
} from '@unionkitbot/shared';
import type { Repositories, RedisState } from '@unionkitbot/database';
import { taskRowToPriorityTask } from '@unionkitbot/database';
import type { AgentEventEmitter } from './events.js';
import type { AgentContext } from './types.js';
import type { BotRegistry } from './registry.js';
import { MinecraftConnection } from './minecraft/connection.js';
import { Navigator } from './navigation/navigator.js';
import { InventoryService } from './inventory/service.js';
import { ChatService } from './chat/service.js';
import { StorageScanner } from './storage/scanner.js';
import { WaypointService } from './waypoints/service.js';
import { DeathService } from './death/service.js';
import { DeliveryService } from './delivery/delivery-service.js';
import { TpaRequester } from './delivery/tpa-requester.js';
import { OrderService } from './orders/service.js';
import { StorageMappingService } from './storage/mappings.js';
import { safeHost } from '@unionkitbot/shared';
import { WebhookDispatcher } from './webhooks/dispatcher.js';
import { TpaRuntime } from './tpa/runtime.js';
import { createTaskHandlers } from './tasks/handlers.js';

export interface BotDefinitionInput {
  id: string;
  name: string;
  username: string;
  serverHost: string;
  serverPort: number;
  serverVersion: string | null;
  authType: 'offline' | 'microsoft';
  enabled: boolean;
  autoConnect: boolean;
  settings: Record<string, unknown>;
  authmePassword?: string;
  password?: string;
}

export interface RuntimeDependencies {
  logger: Logger;
  events: AgentEventEmitter;
  repositories: Repositories;
  redis: RedisState;
  registry: BotRegistry;
  defaults: AgentSettings;
  heartbeatMs: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Owns one Minecraft agent end to end: connection, task queue, navigation, delivery,
 * storage scanning, chat, TPA and death recovery. All long-running work flows through the
 * priority queue so CRITICAL recovery always preempts normal work.
 */
export class BotRuntime {
  readonly definition: BotDefinitionInput;
  readonly connection: MinecraftConnection;
  readonly queue: PriorityTaskQueue;
  readonly navigator: Navigator;
  readonly inventory: InventoryService;
  readonly chat: ChatService;
  readonly scanner: StorageScanner;
  readonly waypoints: WaypointService;
  readonly death: DeathService;
  readonly delivery: DeliveryService;
  readonly tpa: TpaRuntime;
  readonly outgoingTpa: TpaRequester;
  readonly orders: OrderService;
  readonly reservations: ReservationLedger;
  readonly storageMappings: StorageMappingService;
  readonly webhooks: WebhookDispatcher;

  private readonly deps: RuntimeDependencies;
  private settings: AgentSettings;
  private heartbeat: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private runningTaskId: string | null = null;
  private activeOrderId: string | null = null;
  private unsubscribeWebhooks: (() => void) | null = null;
  /**
   * Write-behind persister for task state. Ordering per task is guaranteed, and terminal
   * transitions are drained in stop() so a shutdown cannot lose them.
   */
  private readonly taskWrites: WriteBehind<PriorityTask>;
  private wasStartedFlag = false;
  private webhookRowId: string | null = null;

  constructor(definition: BotDefinitionInput, deps: RuntimeDependencies) {
    this.definition = definition;
    this.deps = deps;
    this.settings = mergeAgentSettings(deps.defaults, definition.settings);
    const botId = definition.id;

    this.connection = new MinecraftConnection({
      botId,
      logger: deps.logger,
      events: deps.events,
      settings: this.settings,
      server: {
        host: definition.serverHost,
        port: definition.serverPort,
        auth: definition.authType,
        username: definition.username,
        ...(definition.serverVersion ? { version: definition.serverVersion } : {}),
        ...(definition.password ? { password: definition.password } : {}),
        ...(definition.authmePassword ? { authmePassword: definition.authmePassword } : {}),
      },
      callbacks: {
        onStateChange: async (state, reason) => {
          deps.events.emit('bot:state', `state -> ${state}`, { state, reason }, { botId });
          await deps.redis
            .setBotState(botId, { state, reason, at: Date.now() })
            .catch(() => undefined);
        },
        onSpawn: async (bot) => {
          this.startedAt = Date.now();
          await this.onSpawn(bot);
        },
        onEnd: async (reason) => {
          await this.onEnd(reason);
        },
      },
    });

    this.navigator = new Navigator({
      botId,
      logger: deps.logger,
      events: deps.events,
      settings: this.settings,
      getBot: () => this.connection.getBot(),
      onFailure: async (failure) => {
        await deps.repositories.orders
          .recordNavigationFailure({
            botId,
            taskId: this.runningTaskId,
            label: failure.label,
            reason: failure.reason,
            replans: failure.replans,
            elapsedMs: failure.elapsedMs,
            dimension: failure.dimension,
            from: failure.from,
            to: failure.to,
            stuck: failure.stuck,
            metadata: { category: failure.category },
          })
          .catch((error: unknown) => {
            deps.logger.debug({ err: error }, 'failed to record navigation failure');
          });
      },
    });
    this.inventory = new InventoryService(() => this.connection.getBot());
    this.chat = new ChatService({
      botId,
      logger: deps.logger,
      events: deps.events,
      getBot: () => this.connection.getBot(),
    });
    this.waypoints = new WaypointService({
      botId,
      server: `${definition.serverHost}:${definition.serverPort}`,
      logger: deps.logger,
      events: deps.events,
      repository: deps.repositories.waypoints,
    });
    this.scanner = new StorageScanner({
      botId,
      logger: deps.logger,
      events: deps.events,
      getBot: () => this.connection.getBot(),
      getDimension: () => this.dimension(),
    });
    this.death = new DeathService({
      botId,
      username: definition.username,
      logger: deps.logger,
      events: deps.events,
      eventsRepository: deps.repositories.events,
      waypoints: this.waypoints,
      getDimension: () => this.dimension(),
      getActiveTaskId: () => this.runningTaskId,
      getState: () => this.connection.currentState,
      server: `${definition.serverHost}:${definition.serverPort}`,
      getActiveOrderId: () => this.activeOrderId,
    });
    this.delivery = new DeliveryService({
      botId,
      username: definition.username,
      logger: deps.logger,
      events: deps.events,
      getBot: () => this.connection.getBot(),
      navigator: this.navigator,
      inventory: this.inventory,
      scanner: this.scanner,
      waypoints: this.waypoints,
      kits: deps.repositories.kits,
      deliveries: deps.repositories.deliveries,
      storage: deps.repositories.storage,
      getDimension: () => this.dimension(),
      approachDistance: this.settings.delivery.approachDistance,
      verifyTimeoutMs: this.settings.delivery.verifyTimeoutMs,
      dropRange: this.settings.delivery.dropRange,
      getSettings: () => this.settings,
    });
    this.tpa = new TpaRuntime({
      botId,
      logger: deps.logger,
      events: deps.events,
      eventsRepository: deps.repositories.events,
      getSettings: () => this.settings.tpa,
      say: (message) => this.chat.say(message),
    });
    this.outgoingTpa = new TpaRequester({
      botId,
      logger: deps.logger,
      events: deps.events,
      getSettings: () => this.settings.outgoingTpa,
      say: (message) => this.chat.say(message),
      onChat: (handler) => this.chat.onRaw(handler),
      isConnected: () => this.connection.isConnected,
    });
    this.reservations = new ReservationLedger({
      botId,
      logger: deps.logger,
      events: deps.events,
    });
    this.storageMappings = new StorageMappingService({
      botId,
      server: `${definition.serverHost}:${definition.serverPort}`,
      logger: deps.logger,
      events: deps.events,
      mappings: deps.repositories.storageMappings,
      kits: deps.repositories.kits,
      getDimension: () => this.dimension(),
    });
    this.orders = new OrderService({
      botId,
      username: definition.username,
      server: `${definition.serverHost}:${definition.serverPort}`,
      logger: deps.logger,
      events: deps.events,
      getSettings: () => this.settings,
      inventory: this.inventory,
      navigator: this.navigator,
      delivery: this.delivery,
      tpa: this.outgoingTpa,
      reservations: this.reservations,
      kits: deps.repositories.kits,
      orders: deps.repositories.orders,
      storageMappings: deps.repositories.storageMappings,
      accountLinks: deps.repositories.accountLinks,
      isConnected: () => this.connection.isConnected,
      onOrderActive: (orderId) => {
        this.activeOrderId = orderId;
      },
      onOrderFinished: () => {
        this.activeOrderId = null;
      },
    });
    this.webhooks = new WebhookDispatcher({
      logger: deps.logger,
      events: deps.events,
      repository: deps.repositories.webhooks,
      getConfig: () => this.settings.webhooks,
      getWebhookId: () => this.webhookRowId,
    });

    this.taskWrites = new WriteBehind<PriorityTask>(
      (task) => task.id,
      async (task) => {
        await this.deps.repositories.tasks.upsert(task);
      },
      { logger: deps.logger },
    );

    this.queue = new PriorityTaskQueue(1, {
      onTaskUpdated: (task) => {
        if (task.status === 'RUNNING') this.runningTaskId = task.id;
        else if (this.runningTaskId === task.id) this.runningTaskId = null;
        this.taskWrites.save(task);
      },
      onTaskDropped: (task, reason) => {
        deps.events.emit(
          'bot:task',
          `task ${task.type} failed permanently: ${reason}`,
          {
            taskId: task.id,
            type: task.type,
            reason,
          },
          { botId, severity: 'error' },
        );
      },
    });

    const context = this.buildContext();
    for (const [type, handler] of Object.entries(createTaskHandlers(context))) {
      this.queue.registerHandler(type as TaskType, handler);
    }

    this.wireChat();
  }

  private buildContext(): AgentContext {
    return {
      botId: this.definition.id,
      events: this.deps.events,
      settings: this.settings,
      connection: this.connection,
      navigator: this.navigator,
      delivery: this.delivery,
      scanner: this.scanner,
      waypoints: this.waypoints,
      chat: this.chat,
      inventory: this.inventory,
      death: this.death,
      tpa: this.tpa.state,
      registry: this.deps.registry,
      storage: this.deps.repositories.storage,
      orders: this.orders,
      reservations: this.reservations,
      outgoingTpa: this.outgoingTpa,
      storageMappings: this.storageMappings,
      getBot: () => this.connection.getBot(),
      getState: () => this.connection.currentState,
    };
  }

  // ------------------------------------------------------------------ lifecycle

  get state() {
    return this.connection.currentState;
  }

  get isConnected(): boolean {
    return this.connection.isConnected;
  }

  get currentSettings(): AgentSettings {
    return this.settings;
  }

  /** Whether start() has been called and stop() has not; used when rebuilding a runtime. */
  get wasStarted(): boolean {
    return this.wasStartedFlag;
  }

  async start(): Promise<void> {
    if (!this.definition.enabled) {
      this.deps.logger.warn({ bot: this.definition.name }, 'bot is disabled; not starting');
      return;
    }
    this.wasStartedFlag = true;
    this.startedAt = Date.now();
    const session = await this.deps.repositories.sessions
      .create({
        botId: this.definition.id,
        state: 'CONNECTING',
        serverHost: `${this.definition.serverHost}:${this.definition.serverPort}`,
        reconnectCount: 0,
      })
      .catch((error: unknown) => {
        this.deps.logger.error({ err: error }, 'failed to create session row');
        return null;
      });
    this.connection.setSessionRowId(session?.id ?? null);

    // Load the durable webhook configuration and start delivering events. A failure here
    // disables webhooks for this bot but must never stop the bot from connecting.
    this.unsubscribeWebhooks = this.webhooks.start();
    await this.loadWebhookConfig().catch((error: unknown) => {
      this.deps.logger.warn({ err: error }, 'failed to load webhook configuration');
    });
    await this.orders.restoreReservations().catch((error: unknown) => {
      this.deps.logger.warn({ err: error }, 'failed to restore item reservations');
    });

    this.enqueue('CONNECT', 'CRITICAL', {}, 'startup connect');
    this.startHeartbeat();
  }

  /**
   * Reads the persisted webhook row into the in-memory settings and remembers its id for
   * delivery history. When no row exists the configured defaults apply unchanged.
   */
  private async loadWebhookConfig(): Promise<void> {
    const row = await this.deps.repositories.webhooks.getByName('default');
    if (!row) return;
    this.webhookRowId = row.id;
    this.settings = {
      ...this.settings,
      webhooks: {
        enabled: row.enabled,
        url: row.url,
        events: row.events,
        retryCount: row.retryCount,
        timeoutMs: row.timeoutMs,
        rateLimitPerMinute: row.rateLimitPerMinute,
        includePayload: row.includePayload,
      } as AgentSettings['webhooks'],
    };
  }

  /** Re-reads the persisted webhook row; call after an operator edits webhook settings. */
  async reloadWebhookConfig(): Promise<void> {
    await this.loadWebhookConfig();
  }

  async stop(reason = 'requested by operator'): Promise<void> {
    this.wasStartedFlag = false;
    this.queue.cancelAll(reason);
    this.navigator.cancel(reason);
    this.outgoingTpa.cancel();
    this.unsubscribeWebhooks?.();
    this.unsubscribeWebhooks = null;
    await this.connection.stop(reason);
    this.stopHeartbeat();
    // Drain terminal task states before releasing the session, so a restart does not
    // resurrect finished tasks as RUNNING.
    await this.flushTaskWrites().catch((error: unknown) =>
      this.deps.logger.debug({ err: error }, 'failed draining task writes'),
    );
    // Give in-flight webhook deliveries a bounded window to finish before shutting down.
    await this.webhooks.drain(3_000).catch((error: unknown) =>
      this.deps.logger.debug({ err: error }, 'failed draining webhook deliveries'),
    );
    this.outgoingTpa.dispose();
    await this.closeSession(reason);
    await this.deps.redis.clearBotState(this.definition.id).catch(() => undefined);
  }

  async restart(): Promise<void> {
    await this.stop('restart');
    await this.start();
  }

  async closeSession(reason: string): Promise<void> {
    const sessionId = this.connection.getSessionRowId();
    if (!sessionId) return;
    await this.deps.repositories.sessions
      .close(sessionId, this.connection.currentState, reason)
      .catch((error: unknown) => this.deps.logger.debug({ err: error }, 'failed closing session'));
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      void this.publishHeartbeat();
    }, this.deps.heartbeatMs);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async publishHeartbeat(): Promise<void> {
    const snapshot = this.snapshot();
    await this.deps.redis.setBotState(this.definition.id, snapshot).catch(() => undefined);
    this.deps.events.emit('bot:heartbeat', 'heartbeat', snapshot, { botId: this.definition.id });
  }

  private async onSpawn(bot: import('mineflayer').Bot): Promise<void> {
    // mineflayer emits both 'message' and 'chat' for player chat, so 'message' handles
    // server/system lines and 'chat' handles players; ingesting both would double-fire.
    bot.on('message', (message: { toString: () => string }) => {
      const text = message.toString();
      // Skip player chat here; the 'chat' handler below classifies it with attribution.
      if (parseChatEnvelope(stripFormatting(text)).player) return;
      void this.chat.ingest(text, null);
    });
    bot.on('chat', (username: string, message: string) => {
      if (username === bot.username) return;
      void this.chat.ingest(`${username}: ${message}`, username);
    });

    await this.deps.repositories.sessions
      .create({
        botId: this.definition.id,
        state: 'IDLE',
        serverHost: `${this.definition.serverHost}:${this.definition.serverPort}`,
        reconnectCount: this.connection.currentReconnectCount,
      })
      .then((row) => this.connection.setSessionRowId(row.id))
      .catch((error: unknown) =>
        this.deps.logger.debug({ err: error }, 'failed to record spawn session'),
      );

    this.deps.events.emit(
      'bot:connected',
      `${this.definition.username} connected`,
      {
        username: this.definition.username,
        server: `${this.definition.serverHost}:${this.definition.serverPort}`,
      },
      { botId: this.definition.id },
    );
    await this.publishHeartbeat();
  }

  private async onEnd(reason: string): Promise<void> {
    this.deps.events.emit(
      'bot:disconnected',
      `disconnected: ${reason}`,
      { reason },
      {
        botId: this.definition.id,
        severity: 'warn',
      },
    );
    await this.closeSession(reason);
    await this.deps.redis.clearBotState(this.definition.id).catch(() => undefined);
  }

  // ------------------------------------------------------------------ wiring

  private wireChat(): void {
    this.chat.on('TPA_REQUEST', (message) => {
      const player = message.parsed.player ?? message.username;
      if (!player) return;
      this.enqueue('TPA_HANDLING', 'HIGH', { player, accept: false }, `tpa from ${player}`);
      void this.tpa.handleRequest(player, null);
    });

    this.chat.on('DELIVERY_REQUEST', (message) => {
      const player = message.parsed.player ?? message.username;
      if (!player) return;
      const rest = String(message.parsed.payload['rest'] ?? '').trim();
      const kitIds = rest.length > 0 ? rest.split(/\s+/).filter(Boolean) : ['starter'];
      this.enqueue(
        'DELIVERY',
        'NORMAL',
        { recipient: player, kitIds, note: 'chat request' },
        'chat delivery request',
      );
    });

    this.chat.on('GREETING', () => {
      if (!this.settings.chat.respondToGreetings) return;
      this.enqueue(
        'CHAT_REPLY',
        'LOW',
        { message: this.settings.chat.greetingMessage },
        'greeting',
      );
    });

    this.chat.on('DEATH', (message) => {
      const player = message.parsed.player ?? message.username;
      const self = this.definition.username.toLowerCase();
      if (player && player.toLowerCase() !== self) return;
      void this.handleDeath(message.parsed.coordinates, message.raw);
    });
  }

  /**
   * Records a legitimate death and queues CRITICAL recovery. Called from the death chat
   * event and from the mineflayer 'death' listener.
   */
  async handleDeath(coordinates: Vec3Like | null, cause: string | null): Promise<void> {
    const record = await this.death.recordDeath(coordinates, cause);
    this.enqueue(
      'DEATH_RECOVERY',
      'CRITICAL',
      { deathEventId: record.deathEventId },
      'death recovery',
    );
  }

  // ------------------------------------------------------------------ tasks

  enqueue<T>(type: TaskType, priority: TaskPriority, payload: T, label?: string): PriorityTask<T> {
    const task = this.queue.enqueue<T>({
      botId: this.definition.id,
      type,
      priority,
      payload,
    });
    this.deps.events.emit(
      'bot:task',
      `task ${type} enqueued${label ? ` (${label})` : ''}`,
      {
        taskId: task.id,
        type,
        priority,
        label,
      },
      { botId: this.definition.id },
    );
    return task;
  }

  /**
   * Drains pending task-state writes without closing the writer, so stop/restart keeps
   * persisting. Terminal transitions must reach Postgres before the session closes,
   * otherwise a finished task is restored as RUNNING on the next boot.
   */
  async flushTaskWrites(): Promise<void> {
    await this.taskWrites.flush();
  }

  /** Final drain on process shutdown. After this the writer rejects further snapshots. */
  async closeTaskWrites(): Promise<void> {
    await this.taskWrites.close();
  }

  /** Restores in-flight tasks after a process restart, preserving their resume state. */
  async restoreTasks(): Promise<number> {
    const rows = await this.deps.repositories.tasks.resumable();
    for (const row of rows) this.queue.hydrate(taskRowToPriorityTask(row));
    if (rows.length > 0) {
      this.queue.resume();
      this.deps.events.emit(
        'system:event',
        `restored ${rows.length} task(s) after restart`,
        {
          restored: rows.length,
        },
        { botId: this.definition.id },
      );
    }
    return rows.length;
  }

  cancelTask(taskId: string): boolean {
    return this.queue.cancel(taskId, 'cancelled via API');
  }

  pauseTask(taskId: string): boolean {
    return this.queue.pauseTask(taskId);
  }

  resumeTask(taskId: string): boolean {
    return this.queue.resumeTask(taskId);
  }

  listTasks(): PriorityTask[] {
    return this.queue.list();
  }

  // ------------------------------------------------------------------ orders

  async listOrders(limit = 50) {
    return this.deps.repositories.orders.list({ botId: this.definition.id, limit });
  }

  /**
   * Persists a new order and queues its execution task.
   *
   * Creation is deliberately separate from execution: the operator gets the order code back
   * immediately, and the task queue decides when the bot actually starts on it.
   */
  async createOrder(input: {
    kitIds: string[];
    recipient?: string | null;
    discordUserId?: string | null;
    requestedBy: string;
    source: 'discord' | 'api' | 'chat' | 'cli';
  }) {
    const order = await this.orders.create({
      kitIds: input.kitIds,
      recipient: input.recipient ?? null,
      discordUserId: input.discordUserId ?? null,
      requestedBy: input.requestedBy,
      source: input.source,
    });
    this.enqueue(
      'ORDER',
      'HIGH',
      { orderId: order.id },
      `order #${order.code} for ${order.recipientUsername ?? 'unknown'}`,
    );
    return order;
  }

  /** Cancels by order code when the argument is numeric, otherwise by id. */
  async cancelOrder(codeOrId: string, actor: string): Promise<boolean> {
    const byCode = /^\d+$/.test(codeOrId)
      ? await this.deps.repositories.orders.getByCode(this.definition.id, Number(codeOrId))
      : await this.deps.repositories.orders.get(codeOrId);
    if (!byCode) return false;
    if (byCode.botId && byCode.botId !== this.definition.id) return false;
    return this.orders.cancel(byCode.id, `cancelled by ${actor}`);
  }

  async setStorageMapping(groupOrId: string, kitId: string | null, actor: string) {
    return this.storageMappings.override(groupOrId, kitId, actor);
  }

  /** Redacted view of webhook configuration; the URL is never returned. */
  async webhookSnapshot(): Promise<{
    enabled: boolean;
    configured: boolean;
    urlHost: string | null;
    events: string[];
    retryCount: number;
    timeoutMs: number;
    rateLimitPerMinute: number;
    includePayload: boolean;
  }> {
    const config = this.settings.webhooks;
    return {
      enabled: config.enabled,
      configured: Boolean(config.url),
      urlHost: config.url ? safeHost(config.url) : null,
      events: [...config.events],
      retryCount: config.retryCount,
      timeoutMs: config.timeoutMs,
      rateLimitPerMinute: config.rateLimitPerMinute,
      includePayload: config.includePayload,
    };
  }

  // ------------------------------------------------------------------ status

  dimension(): string {
    const bot = this.connection.getBot();
    const dimension = (bot as unknown as { game?: { dimension?: string } } | null)?.game?.dimension;
    return dimension ?? 'overworld';
  }

  snapshot(): BotRuntimeSnapshot {
    const bot = this.connection.getBot();
    const position = bot
      ? {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z,
          yaw: bot.entity.yaw,
          pitch: bot.entity.pitch,
          dimension: this.dimension(),
        }
      : null;
    const running = this.queue.list().find((t) => t.status === 'RUNNING') ?? null;

    return {
      botId: this.definition.id,
      username: this.definition.username,
      server: `${this.definition.serverHost}:${this.definition.serverPort}`,
      state: this.connection.currentState,
      connected: this.connection.isConnected,
      position,
      health: bot ? bot.health : null,
      food: bot ? bot.food : null,
      dimension: this.dimension(),
      uptimeMs: this.connection.uptimeMs || Date.now() - this.startedAt,
      reconnectCount: this.connection.currentReconnectCount,
      currentTaskId: running?.id ?? null,
      currentTaskType: running?.type ?? null,
      target: this.navigator.target,
      pathfinding: this.navigator.currentStatus,
      inventory: this.inventory.summary(),
      lastHeartbeat: new Date().toISOString(),
    };
  }

  async statusText(): Promise<string> {
    const snapshot = this.snapshot();
    const deliveries = await this.deps.repositories.deliveries
      .list({ botId: this.definition.id, limit: 1 })
      .catch(() => []);
    const lastDelivery = deliveries[0];
    const lines = [
      `bot: ${snapshot.username} (${this.definition.name})`,
      `state: ${snapshot.state}  connected: ${snapshot.connected}`,
      `server: ${snapshot.server}`,
      snapshot.position
        ? `position: ${snapshot.position.x.toFixed(1)}, ${snapshot.position.y.toFixed(1)}, ${snapshot.position.z.toFixed(1)} (${snapshot.dimension})`
        : 'position: unknown',
      `health: ${snapshot.health ?? '-'}  food: ${snapshot.food ?? '-'}`,
      `task: ${snapshot.currentTaskType ?? 'none'}`,
      `target: ${snapshot.target ?? 'none'}`,
      `pathfinding: ${snapshot.pathfinding}`,
      `uptime: ${(snapshot.uptimeMs / 1000).toFixed(0)}s  reconnects: ${snapshot.reconnectCount}`,
      `pending tasks: ${this.queue.list().filter((t) => t.status === 'PENDING').length}`,
      lastDelivery
        ? `last delivery: ${lastDelivery.status} to ${lastDelivery.recipient}`
        : 'last delivery: none',
      `tpa mode: ${this.settings.tpa.mode}  pending: ${this.tpa.pending()}`,
    ];
    return lines.join('\n');
  }

  applySettings(patch: unknown): AgentSettings {
    this.settings = mergeAgentSettings(this.settings, patch);
    return this.settings;
  }

  get priorityWeights(): Record<TaskPriority, number> {
    return PRIORITY_WEIGHT;
  }

  dispose(): void {
    this.stopHeartbeat();
    this.tpa.dispose();
    this.connection.dispose();
  }
}
