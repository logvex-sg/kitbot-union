import mineflayer, { type Bot, type BotOptions } from 'mineflayer';
// CommonJS module: default-import then destructure so Node's ESM loader can resolve it.
import mineflayerPathfinder from 'mineflayer-pathfinder';
import {
  NotConnectedError,
  StateMachine,
  backoffDelay,
  sleep,
  type AgentSettings,
  type BotState,
  type Logger,
  type ServerConfig,
} from '@unionkitbot/shared';
import type { AgentEventEmitter } from '../events.js';

const { pathfinder } = mineflayerPathfinder;

export interface ConnectionCallbacks {
  onSpawn?: (bot: Bot) => void | Promise<void>;
  onEnd?: (reason: string) => void | Promise<void>;
  onError?: (error: Error) => void;
  /** Called on every state transition so the runtime can persist it. */
  onStateChange?: (state: BotState, reason: string) => void | Promise<void>;
}

export interface ConnectionOptions {
  botId: string;
  server: ServerConfig;
  settings: AgentSettings;
  logger: Logger;
  events: AgentEventEmitter;
  callbacks?: ConnectionCallbacks;
  /** Factory seam so tests can inject a fake bot without touching the network. */
  botFactory?: (options: BotOptions) => Bot;
}

/**
 * Owns exactly one mineflayer bot instance and the reconnect lifecycle.
 * Normal disconnects are retried with exponential backoff; explicit stop() never reconnects.
 */
export class MinecraftConnection {
  readonly stateMachine: StateMachine;
  readonly options: ConnectionOptions;
  private bot: Bot | null = null;
  private stopping = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastError: Error | null = null;
  private connectedAt: number | null = null;
  private reconnectCount = 0;
  private sessionRowId: string | null = null;
  private spawnResolved = false;
  private readonly botFactory: (options: BotOptions) => Bot;
  private listeners: Array<{ event: string; handler: (...args: never[]) => void }> = [];

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.stateMachine = new StateMachine('OFFLINE');
    this.botFactory = options.botFactory ?? ((opts) => mineflayer.createBot(opts));
    this.stateMachine.onChange((change) => {
      void this.options.callbacks?.onStateChange?.(change.to, change.reason);
    });
  }

  get currentState(): BotState {
    return this.stateMachine.current;
  }

  get isConnected(): boolean {
    return this.bot !== null && this.spawnResolved && !this.stopping;
  }

  get uptimeMs(): number {
    return this.connectedAt ? Date.now() - this.connectedAt : 0;
  }

  get currentReconnectCount(): number {
    return this.reconnectCount;
  }

  get error(): Error | null {
    return this.lastError;
  }

  getBot(): Bot | null {
    return this.bot;
  }

  setSessionRowId(id: string | null): void {
    this.sessionRowId = id;
  }

  getSessionRowId(): string | null {
    return this.sessionRowId;
  }

  private transition(to: BotState, reason: string): void {
    if (this.stateMachine.current === to) return;
    if (!this.stateMachine.transition(to, reason)) {
      this.options.logger.debug(
        { from: this.stateMachine.current, to, reason },
        'refused state transition',
      );
      return;
    }
    this.options.events.emit(
      'bot:state',
      `state ${this.stateMachine.current}`,
      {
        state: to,
        reason,
      },
      { botId: this.options.botId },
    );
  }

  /** Attempts a single connection. Resolves once the bot has spawned. */
  async connect(timeoutMs = 60_000): Promise<Bot> {
    if (this.isConnected && this.bot) return this.bot;
    this.stopping = false;
    this.transition('CONNECTING', 'connect requested');

    const botOptions: BotOptions = {
      host: this.options.server.host,
      port: this.options.server.port,
      username: this.options.server.username,
      auth: this.options.server.auth === 'microsoft' ? 'microsoft' : 'offline',
      hideErrors: true,
      ...(this.options.server.version ? { version: this.options.server.version } : {}),
      ...(this.options.server.password ? { password: this.options.server.password } : {}),
    };

    const bot = this.botFactory(botOptions);
    this.bot = bot;
    this.spawnResolved = false;
    this.lastError = null;
    bot.loadPlugin(pathfinder);
    this.attachListeners(bot);

    return new Promise<Bot>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.transition('ERROR', 'connection timeout');
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for spawn`));
      }, timeoutMs);

      const onSpawn = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.spawnResolved = true;
        this.connectedAt = Date.now();
        this.reconnectAttempts = 0;
        this.transition('SPAWNING', 'spawn event');
        this.transition('IDLE', 'spawn complete');
        this.options.events.emit(
          'bot:spawned',
          'bot spawned',
          {
            username: bot.username,
            server: `${this.options.server.host}:${this.options.server.port}`,
          },
          { botId: this.options.botId },
        );
        void this.options.callbacks?.onSpawn?.(bot);
        resolve(bot);
      };

      const onError = (error: Error): void => {
        this.lastError = error;
        this.options.events.emit(
          'bot:error',
          `connect error: ${error.message}`,
          {
            error: error.message,
          },
          { botId: this.options.botId, severity: 'error' },
        );
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      };

      const onEnd = (reason: string): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Connection ended before spawn: ${reason}`));
        }
      };

      bot.once('spawn', onSpawn);
      bot.once('error', onError);
      bot.once('end', onEnd);
    });
  }

  private attachListeners(bot: Bot): void {
    const on = (event: string, handler: (...args: never[]) => void): void => {
      (bot.on as (e: string, h: (...args: never[]) => void) => void)(event, handler);
      this.listeners.push({ event, handler });
    };

    on('login', () => {
      this.options.events.emit(
        'bot:connected',
        'logged in',
        { username: bot.username },
        {
          botId: this.options.botId,
        },
      );
    });

    on('kicked', (reason: unknown) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason ?? {});
      this.options.events.emit(
        'bot:disconnected',
        `kicked: ${text}`,
        { reason: text },
        {
          botId: this.options.botId,
          severity: 'warn',
        },
      );
    });

    on('end', (reason: string) => {
      const text = reason ?? 'unknown';
      this.spawnResolved = false;
      this.connectedAt = null;
      this.detachListeners(bot);
      if (this.bot === bot) this.bot = null;
      this.options.events.emit(
        'bot:disconnected',
        `disconnected: ${text}`,
        { reason: text },
        {
          botId: this.options.botId,
          severity: 'warn',
        },
      );
      void this.options.callbacks?.onEnd?.(text);
      if (!this.stopping) {
        this.transition('DISCONNECTED', `end: ${text}`);
        void this.scheduleReconnect(`end: ${text}`);
      }
    });

    on('error', (error: Error) => {
      this.lastError = error;
      this.options.events.emit(
        'bot:error',
        error.message,
        { error: error.message },
        {
          botId: this.options.botId,
          severity: 'error',
        },
      );
      void this.options.callbacks?.onError?.(error);
    });

    on('death', () => {
      this.options.events.emit(
        'bot:state',
        'bot died',
        { state: 'DEAD' },
        {
          botId: this.options.botId,
          severity: 'warn',
        },
      );
      this.transition('DEAD', 'death event');
    });

    on('respawn', () => {
      this.options.events.emit(
        'bot:state',
        'respawned',
        { state: 'IDLE' },
        {
          botId: this.options.botId,
        },
      );
      this.transition('IDLE', 'respawn event');
    });
  }

  private detachListeners(bot: Bot): void {
    for (const { event, handler } of this.listeners) {
      (bot.off as (e: string, h: (...args: never[]) => void) => void)(event, handler);
    }
    this.listeners = [];
  }

  /** Exponential backoff with optional jitter, bounded by settings.reconnect.maxAttempts. */
  private async scheduleReconnect(reason: string): Promise<void> {
    const { reconnect } = this.options.settings;
    if (reconnect.maxAttempts > 0 && this.reconnectAttempts >= reconnect.maxAttempts) {
      this.transition('ERROR', `reconnect attempts exhausted (${reconnect.maxAttempts})`);
      this.options.events.emit(
        'bot:error',
        `giving up after ${this.reconnectAttempts} reconnect attempts`,
        { reason },
        { botId: this.options.botId, severity: 'critical' },
      );
      return;
    }
    this.reconnectAttempts += 1;
    this.reconnectCount += 1;
    const delay = backoffDelay(this.reconnectAttempts, reconnect);
    this.transition('RECOVERING', `reconnect attempt ${this.reconnectAttempts}`);
    this.options.events.emit(
      'bot:reconnecting',
      `reconnect attempt ${this.reconnectAttempts} in ${delay}ms`,
      { attempt: this.reconnectAttempts, delay, reason },
      { botId: this.options.botId, severity: 'warn' },
    );
    await sleep(delay);
    if (this.stopping) return;
    try {
      await this.connect();
      this.options.events.emit(
        'bot:connected',
        'reconnected',
        {
          attempts: this.reconnectAttempts,
        },
        { botId: this.options.botId },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = error instanceof Error ? error : new Error(message);
      await this.scheduleReconnect(message);
    }
  }

  /** Explicitly stop; suppresses automatic reconnection. */
  async stop(reason = 'requested by operator'): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const bot = this.bot;
    if (bot) {
      this.detachListeners(bot);
      try {
        bot.quit(reason);
      } catch (error) {
        this.options.logger.debug({ err: error }, 'quit threw');
      }
      this.bot = null;
    }
    this.spawnResolved = false;
    this.connectedAt = null;
    this.transition('OFFLINE', reason);
    await this.options.callbacks?.onEnd?.(reason);
  }

  requireBot(): Bot {
    if (!this.bot || !this.spawnResolved) throw new NotConnectedError();
    return this.bot;
  }

  /** Persisted reconnect counter is restored on boot so backoff survives restarts. */
  restoreReconnectState(reconnectCount: number): void {
    this.reconnectCount = reconnectCount;
    this.reconnectAttempts = reconnectCount;
  }

  dispose(): void {
    this.detachListeners(this.bot ?? ({} as Bot));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.bot = null;
  }
}
