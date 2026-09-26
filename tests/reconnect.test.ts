import { describe, expect, it } from 'vitest';
import { backoffDelay, retryAsync, shouldRetry, type BackoffOptions } from '@unionkitbot/shared';
import { MinecraftConnection } from '../apps/agent/src/minecraft/connection.js';
import { AgentEventEmitter } from '../apps/agent/src/events.js';
import { createLogger } from '@unionkitbot/shared';
import { defaultAgentSettings } from '@unionkitbot/config';

const opts = (patch: Partial<BackoffOptions> = {}): BackoffOptions => ({
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  jitter: false,
  ...patch,
});

describe('reconnect backoff', () => {
  it('grows exponentially and clamps at the maximum', () => {
    expect(backoffDelay(1, opts())).toBe(1000);
    expect(backoffDelay(2, opts())).toBe(2000);
    expect(backoffDelay(3, opts())).toBe(4000);
    expect(backoffDelay(10, opts())).toBe(60_000);
  });

  it('applies symmetric jitter around the delay and never exceeds maxDelayMs', () => {
    const base = backoffDelay(4, opts());
    // random() = 0 => lower bound, random() = 1 => upper bound
    const low = backoffDelay(4, opts({ jitter: true }), () => 0);
    const high = backoffDelay(4, opts({ jitter: true }), () => 1);
    expect(low).toBe(base - 1000);
    expect(high).toBe(base + 1000);
    expect(low).toBeLessThanOrEqual(base);
    expect(high).toBeGreaterThanOrEqual(base);
  });

  it('clamps jittered delays at the configured ceiling', () => {
    const capped = backoffDelay(20, opts({ jitter: true, maxDelayMs: 1000 }), () => 1);
    expect(capped).toBeLessThanOrEqual(1000);
  });

  it('respects maxAttempts', () => {
    expect(shouldRetry(1, opts({ maxAttempts: 3 }))).toBe(true);
    expect(shouldRetry(3, opts({ maxAttempts: 3 }))).toBe(false);
    expect(shouldRetry(99, opts())).toBe(true);
  });

  it('retries until success and reports each retry', async () => {
    const seen: number[] = [];
    let calls = 0;
    const value = await retryAsync(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { ...opts({ baseDelayMs: 1, maxAttempts: 5 }), onRetry: (attempt) => seen.push(attempt) },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(seen).toEqual([1, 2]);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    await expect(
      retryAsync(
        async () => {
          throw new Error('always down');
        },
        opts({ baseDelayMs: 1, maxAttempts: 2 }),
      ),
    ).rejects.toThrow('always down');
  });
});

describe('connection reconnect behaviour', () => {
  const build = () => {
    const events = new AgentEventEmitter();
    const settings = defaultAgentSettings({ AGENT_HEARTBEAT_MS: 1000, MC_CONFIG_PATH: '' });
    settings.reconnect = { baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 3, jitter: false };
    const connection = new MinecraftConnection({
      botId: 'bot-1',
      server: { host: 'localhost', port: 25565, auth: 'offline', username: 'Tester' },
      settings,
      logger: createLogger({ name: 'test', level: 'silent' }),
      events,
    });
    return { connection, events };
  };

  it('starts OFFLINE and restores persisted reconnect counts', () => {
    const { connection } = build();
    expect(connection.currentState).toBe('OFFLINE');
    expect(connection.currentReconnectCount).toBe(0);
    connection.restoreReconnectState(7);
    expect(connection.currentReconnectCount).toBe(7);
  });

  it('reports no bot when disconnected so callers fail fast', () => {
    const { connection } = build();
    expect(connection.getBot()).toBeNull();
    expect(connection.isConnected).toBe(false);
    expect(() => connection.requireBot()).toThrow(/not connected/i);
  });

  it('rejects a spawn that never arrives', async () => {
    build();
    const fake = {
      loadPlugin: () => undefined,
      once: () => undefined,
      on: () => undefined,
      off: () => undefined,
      quit: () => undefined,
    } as never;
    const failing = new MinecraftConnection({
      botId: 'bot-2',
      server: { host: 'localhost', port: 25565, auth: 'offline', username: 'Tester' },
      settings: defaultAgentSettings({ AGENT_HEARTBEAT_MS: 1000, MC_CONFIG_PATH: '' }),
      logger: createLogger({ name: 'test2', level: 'silent' }),
      events: new AgentEventEmitter(),
      botFactory: () => fake,
    });
    await expect(failing.connect(30)).rejects.toThrow(/Timed out/);
    expect(failing.currentState).toBe('ERROR');
  });

  it('stop() never reconnects and lands in OFFLINE', async () => {
    const { connection } = build();
    await connection.stop('test shutdown');
    expect(connection.currentState).toBe('OFFLINE');
    expect(connection.isConnected).toBe(false);
  });
});
