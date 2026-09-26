import type {
  AgentSettings,
  BotRuntimeSnapshot,
  Logger,
  PriorityTask,
  TaskPriority,
  TaskType,
} from '@unionkitbot/shared';
import { PRIORITY_WEIGHT, PriorityTaskQueue, WriteBehind, mergeAgentSettings, parseChatEnvelope, stripFormatting } from '@unionkitbot/shared';
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

  private readonly deps: RuntimeDependencies;
  private settings: AgentSettings;
  private heartbeat: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private runningTaskId: string | null = null;
  /**
   * Write-behind persister for task state. Ordering per task is guaranteed, and terminal
   * transitions are drained in stop() so a shutdown cannot lose them.
   */
  private readonly taskWrites: WriteBehind<PriorityTask>;
  private wasStartedFlag = false;

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
    });
    this.tpa = new TpaRuntime({
      botId,
      logger: deps.logger,
      events: deps.events,
      eventsRepository: deps.repositories.events,
      getSettings: () => this.settings.tpa,
      say: (message) => this.chat.say(message),
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
      getBot: () => this.connection.getBot(),
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

    this.enqueue('CONNECT', 'CRITICAL', {}, 'startup connect');
    this.startHeartbeat();
  }

  async stop(reason = 'requested by operator'): Promise<void> {
    this.wasStartedFlag = false;
    this.queue.cancelAll(reason);
    this.navigator.cancel(reason);
    await this.connection.stop(reason);
    this.stopHeartbeat();
    // Drain terminal task states before releasing the session, so a restart does not
    // resurrect finished tasks as RUNNING.
    await this.flushTaskWrites().catch((error: unknown) =>
      this.deps.logger.debug({ err: error }, 'failed draining task writes'),
    );
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
