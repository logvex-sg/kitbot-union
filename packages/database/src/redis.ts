import { Redis } from 'ioredis';
import type { Logger } from '@unionkitbot/shared';

export interface RedisOptions {
  url: string;
  logger?: Logger;
  keyPrefix?: string;
}

export const REDIS_CHANNELS = {
  events: 'ukb:events',
  botState: 'ukb:bot-state',
} as const;

/** Namespaced key helpers keep every key discoverable and greppable. */
export class RedisKeys {
  constructor(private readonly prefix = 'ukb') {}
  bot(botId: string): string {
    return `${this.prefix}:bot:${botId}`;
  }
  botState(botId: string): string {
    return `${this.prefix}:bot:${botId}:state`;
  }
  botLock(botId: string): string {
    return `${this.prefix}:bot:${botId}:lock`;
  }
  botTaskLock(botId: string): string {
    return `${this.prefix}:bot:${botId}:task-lock`;
  }
  cooldown(botId: string, name: string): string {
    return `${this.prefix}:cooldown:${botId}:${name}`;
  }
  tpaPending(botId: string): string {
    return `${this.prefix}:tpa:${botId}:pending`;
  }
  cache(key: string): string {
    return `${this.prefix}:cache:${key}`;
  }
  wsClients(): string {
    return `${this.prefix}:ws:clients`;
  }
}

/**
 * Ephemeral state layer. PostgreSQL remains the source of truth; everything here is
 * rebuildable (locks, cooldowns, live snapshots, caches).
 */
export class RedisState {
  readonly client: Redis;
  readonly keys: RedisKeys;
  private readonly logger?: Logger;

  constructor(options: RedisOptions) {
    this.client = new Redis(options.url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times: number) => Math.min(1000 * 2 ** Math.min(times, 6), 30_000),
    });
    this.keys = new RedisKeys(options.keyPrefix);
    if (options.logger) this.logger = options.logger;
    this.client.on('error', (error: Error) => this.logger?.error({ err: error }, 'redis error'));
  }

  static fromUrl(url: string, logger?: Logger, keyPrefix?: string): RedisState {
    return new RedisState({ url, logger, ...(keyPrefix !== undefined ? { keyPrefix } : {}) });
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.client.ping();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  async setBotState(botId: string, snapshot: unknown, ttlSeconds = 120): Promise<void> {
    await this.client.set(this.keys.botState(botId), JSON.stringify(snapshot), 'EX', ttlSeconds);
  }

  async getBotState<T>(botId: string): Promise<T | null> {
    const raw = await this.client.get(this.keys.botState(botId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async clearBotState(botId: string): Promise<void> {
    await this.client.del(this.keys.botState(botId));
  }

  /**
   * Best-effort exclusive lock. Returns a release function, or null when another
   * process already holds the lock (which prevents duplicate bot instances).
   */
  async acquireLock(
    key: string,
    ttlMs: number,
    owner: string,
  ): Promise<(() => Promise<void>) | null> {
    const result = await this.client.set(key, owner, 'PX', ttlMs, 'NX');
    if (result !== 'OK') return null;
    return async () => {
      const current = await this.client.get(key);
      if (current === owner) await this.client.del(key);
    };
  }

  async withLock<T>(
    key: string,
    ttlMs: number,
    owner: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const release = await this.acquireLock(key, ttlMs, owner);
    if (!release) return null;
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /** Cooldown helper. Returns false when still cooling down. */
  async tryCooldown(botId: string, name: string, ms: number): Promise<boolean> {
    const key = this.keys.cooldown(botId, name);
    const result = await this.client.set(key, '1', 'PX', ms, 'NX');
    return result === 'OK';
  }

  async cooldownRemaining(botId: string, name: string): Promise<number> {
    const ttl = await this.client.pttl(this.keys.cooldown(botId, name));
    return ttl > 0 ? ttl : 0;
  }

  async cacheSet(key: string, value: unknown, ttlSeconds = 30): Promise<void> {
    await this.client.set(this.keys.cache(key), JSON.stringify(value), 'EX', ttlSeconds);
  }

  async cacheGet<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.keys.cache(key));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async trackWsClient(clientId: string): Promise<void> {
    await this.client.sadd(this.keys.wsClients(), clientId);
    await this.client.expire(this.keys.wsClients(), 3600);
  }

  async untrackWsClient(clientId: string): Promise<void> {
    await this.client.srem(this.keys.wsClients(), clientId);
  }

  async wsClientCount(): Promise<number> {
    return this.client.scard(this.keys.wsClients());
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.client.publish(channel, JSON.stringify(payload));
  }

  /** Fan-out of live runtime events to any API process subscribed for WebSockets. */
  async publishEvent(payload: unknown): Promise<void> {
    await this.publish(REDIS_CHANNELS.events, payload);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
