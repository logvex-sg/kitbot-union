import type { BotRuntimeSnapshot, Logger, PriorityTask } from '@unionkitbot/shared';
import type { Repositories, RedisState } from '@unionkitbot/database';
import type { AgentEventEmitter } from './events.js';
import { BotRuntime, type BotDefinitionInput, type RuntimeDependencies } from './runtime.js';

export interface RegistryOptions {
  logger: Logger;
  events: AgentEventEmitter;
  repositories: Repositories;
  redis: RedisState;
  defaults: RuntimeDependencies['defaults'];
  heartbeatMs: number;
}

/**
 * Owns every configured Minecraft agent. A Redis lock guarantees only one agent process
 * drives a given bot, which is what keeps a multi-bot deployment from double-connecting.
 */
export class BotRegistry {
  private readonly runtimes = new Map<string, BotRuntime>();
  private readonly options: RegistryOptions;
  private readonly instanceId: string;

  constructor(options: RegistryOptions) {
    this.options = options;
    this.instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  }

  get size(): number {
    return this.runtimes.size;
  }

  list(): BotRuntime[] {
    return [...this.runtimes.values()];
  }

  get(botId: string): BotRuntime | undefined {
    return this.runtimes.get(botId);
  }

  getByName(name: string): BotRuntime | undefined {
    return this.list().find((r) => r.definition.name === name);
  }

  /** Returns the first runtime, used by Discord slash commands that omit a bot name. */
  first(): BotRuntime | undefined {
    return this.list()[0];
  }

  register(definition: BotDefinitionInput): BotRuntime {
    const existing = this.runtimes.get(definition.id);
    if (existing) return existing;
    const runtime = new BotRuntime(definition, {
      logger: this.options.logger,
      events: this.options.events,
      repositories: this.options.repositories,
      redis: this.options.redis,
      registry: this,
      defaults: this.options.defaults,
      heartbeatMs: this.options.heartbeatMs,
    });
    this.runtimes.set(definition.id, runtime);
    return runtime;
  }

  /** Loads bot definitions from PostgreSQL and starts the ones that should auto-connect. */
  async loadFromDatabase(): Promise<BotRuntime[]> {
    const rows = await this.options.repositories.bots.list();
    const loaded: BotRuntime[] = [];
    for (const row of rows) {
      const runtime = this.register({
        id: row.id,
        name: row.name,
        username: row.username,
        serverHost: row.serverHost,
        serverPort: row.serverPort,
        serverVersion: row.serverVersion,
        authType: row.authType,
        enabled: row.enabled,
        autoConnect: row.autoConnect,
        settings: row.settings,
      });
      loaded.push(runtime);
    }
    return loaded;
  }

  async startAll(): Promise<void> {
    for (const runtime of this.list()) {
      if (!runtime.definition.enabled) continue;
      if (!runtime.definition.autoConnect) continue;
      const lock = await this.options.redis.acquireLock(
        this.options.redis.keys.botLock(runtime.definition.id),
        30_000,
        this.instanceId,
      );
      if (!lock) {
        this.options.logger.warn(
          { bot: runtime.definition.name },
          'another agent instance holds the lock; skipping start',
        );
        continue;
      }
      try {
        await runtime.restoreTasks();
        await runtime.start();
      } catch (error) {
        this.options.logger.error(
          { err: error, bot: runtime.definition.name },
          'failed to start bot',
        );
      }
    }
  }

  async stopAll(reason = 'shutdown'): Promise<void> {
    await Promise.all(this.list().map((runtime) => runtime.stop(reason).catch(() => undefined)));
  }

  snapshots(): BotRuntimeSnapshot[] {
    return this.list().map((runtime) => runtime.snapshot());
  }

  allTasks(): PriorityTask[] {
    return this.list().flatMap((runtime) => runtime.listTasks());
  }

  async publishSnapshot(botId: string): Promise<BotRuntimeSnapshot | null> {
    const runtime = this.get(botId);
    if (!runtime) return null;
    const snapshot = runtime.snapshot();
    await this.options.redis.setBotState(botId, snapshot).catch(() => undefined);
    return snapshot;
  }

  dispose(): void {
    for (const runtime of this.list()) runtime.dispose();
    this.runtimes.clear();
  }

  /**
   * Server address, credentials and version are read once when a runtime is constructed, so a
   * definition change cannot be applied to a live runtime. Rebuild it from the current database
   * row instead, preserving whether it was running and resuming it if so.
   */
  async reload(botId: string): Promise<BotRuntime | null> {
    const row = await this.options.repositories.bots.get(botId);
    if (!row) return null;

    const previous = this.runtimes.get(botId);
    const wasRunning = previous ? previous.wasStarted : false;
    if (previous) {
      await previous.stop('definition reload').catch(() => undefined);
      previous.dispose();
      this.runtimes.delete(botId);
    }

    const runtime = this.register({
      id: row.id,
      name: row.name,
      username: row.username,
      serverHost: row.serverHost,
      serverPort: row.serverPort,
      serverVersion: row.serverVersion,
      authType: row.authType,
      enabled: row.enabled,
      autoConnect: row.autoConnect,
      settings: row.settings,
    });

    if (runtime.definition.enabled && (wasRunning || runtime.definition.autoConnect)) {
      await runtime.start().catch((error: unknown) => {
        this.options.logger.error({ err: error, bot: row.name }, 'failed to restart after reload');
      });
    }
    return runtime;
  }
}
