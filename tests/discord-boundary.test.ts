/**
 * Architectural guard: Discord is a *controller*, never a writer.
 *
 * Every Minecraft action must flow Discord -> AgentClient (WebSocket) -> agent CommandRouter.
 * If the Discord app ever imports the database layer or a Minecraft library directly, a second
 * write path into the world appears and the two sources of truth can diverge.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const discordSrc = fileURLToPath(new URL('../apps/discord/src', import.meta.url));
const discordPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../apps/discord/package.json', import.meta.url)), 'utf8'),
) as { dependencies: Record<string, string> };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('discord controller boundary', () => {
  const files = sourceFiles(discordSrc);

  it('finds the discord source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never imports the database layer', () => {
    const offenders = files.filter((file) =>
      readFileSync(file, 'utf8').includes('@unionkitbot/database'),
    );
    expect(offenders).toEqual([]);
  });

  it('never imports a database driver or mineflayer', () => {
    const forbidden = ["from 'pg'", 'from "pg"', "from 'ioredis'", 'mineflayer'];
    const offenders = files.filter((file) => {
      const body = readFileSync(file, 'utf8');
      return forbidden.some((token) => body.includes(token));
    });
    expect(offenders).toEqual([]);
  });

  it('does not declare a database dependency, so the boundary is structural', () => {
    expect(discordPkg.dependencies).not.toHaveProperty('@unionkitbot/database');
  });

  it('routes every subcommand through the agent client', () => {
    const bot = readFileSync(join(discordSrc, 'bot.ts'), 'utf8');
    const dispatch = bot.slice(bot.indexOf('private async dispatch'), bot.indexOf('recent(limit'));
    const cases = [...dispatch.matchAll(/case '([a-z]+)'/g)].map((m) => m[1]);
    expect(cases.length).toBeGreaterThan(10);
    // Each case must return agent.send(...) or a validation error - never a direct action.
    const sends = [...dispatch.matchAll(/agent\.send\(/g)].length;
    expect(sends).toBeGreaterThanOrEqual(cases.length - 1);
  });

  it('labels the agent client it builds as the discord source', () => {
    const index = readFileSync(join(discordSrc, 'index.ts'), 'utf8');
    expect(index).toContain("source: 'discord'");
  });
});

describe('agent command router is the single write path', () => {
  it('records the originating source and command in the audit trail', async () => {
    const { CommandRouter } = await import('@unionkitbot/agent/commands');
    const audit: { actor: string; action: string; detail: Record<string, unknown> }[] = [];
    const emptyRegistry = {
      size: 0,
      list: () => [],
      first: () => undefined,
      get: () => undefined,
      getByName: () => undefined,
    };
    const router = new CommandRouter(emptyRegistry as never, async (entry) => {
      audit.push(entry as (typeof audit)[number]);
    });

    const result = await router.execute({
      command: 'health',
      args: [],
      source: 'discord',
      actor: 'discord-user-1',
    });

    expect(result.ok).toBe(true);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('command:health');
    expect(audit[0]?.detail['source']).toBe('discord');
    expect(audit[0]?.actor).toBe('discord-user-1');
  });

  it('picks up a bot created after the agent started', async () => {
    const { CommandRouter } = await import('@unionkitbot/agent/commands');

    // Simulates a fresh VPS: Postgres already has the bot, the live registry does not.
    const bots = new Map<
      string,
      {
        name: string;
        definition: { id: string; name: string };
        statusText: () => Promise<string>;
        snapshot: () => object;
      }
    >();
    let reloads = 0;
    const registry = {
      size: 0,
      list: () => [],
      first: () => undefined,
      get: (id: string) => bots.get(id),
      getByName: (name: string) => [...bots.values()].find((b) => b.name === name),
      loadFromDatabase: async () => {
        reloads += 1;
        bots.set('bot-1', {
          name: 'mc-01',
          definition: { id: 'bot-1', name: 'mc-01' },
          statusText: async () => 'mc-01 ONLINE',
          snapshot: () => ({ state: 'IDLE' }),
        });
        return [];
      },
    };

    const router = new CommandRouter(registry as never, async () => undefined);
    const result = await router.execute({
      command: 'status',
      args: [],
      bot: 'mc-01',
      source: 'api',
      actor: 'api',
    });

    expect(reloads).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('mc-01 ONLINE');
  });

  it('does not reload when the bot is already registered', async () => {
    const { CommandRouter } = await import('@unionkitbot/agent/commands');

    let reloads = 0;
    const known = {
      name: 'mc-01',
      definition: { id: 'mc-01', name: 'mc-01' },
      statusText: async () => 'mc-01 ONLINE',
      snapshot: () => ({}),
    };
    const registry = {
      size: 1,
      list: () => [known],
      first: () => known,
      get: (id: string) => (id === 'mc-01' ? known : undefined),
      getByName: (name: string) => (name === 'mc-01' ? known : undefined),
      loadFromDatabase: async () => {
        reloads += 1;
        return [];
      },
    };

    const router = new CommandRouter(registry as never, async () => undefined);
    const result = await router.execute({
      command: 'status',
      args: [],
      bot: 'mc-01',
      source: 'api',
      actor: 'api',
    });

    expect(reloads).toBe(0);
    expect(result.message).toBe('mc-01 ONLINE');
  });

  it('does not silently fall back to another bot when the named bot is unknown', async () => {
    const { CommandRouter } = await import('@unionkitbot/agent/commands');

    // A first bot is loaded, but the caller names a different one that does not exist.
    const other = { name: 'mc-01', definition: { id: 'mc-01', name: 'mc-01' } };
    let reloads = 0;
    const registry = {
      size: 1,
      list: () => [other],
      first: () => other,
      get: () => undefined,
      getByName: () => undefined,
      loadFromDatabase: async () => {
        reloads += 1;
        return [];
      },
    };

    const router = new CommandRouter(registry as never, async () => undefined);
    const result = await router.execute({
      command: 'stop',
      args: [],
      bot: 'mc-99',
      source: 'api',
      actor: 'api',
    });

    expect(reloads).toBe(1);
    // Must not report success against the wrong bot, and must not touch other.
    expect(result.ok).toBe(false);
    expect(result.message).toBe('no bot instance available');
    expect(result.data).toBeUndefined();
  });
});
