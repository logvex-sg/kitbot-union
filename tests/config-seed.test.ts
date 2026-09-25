import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@unionkitbot/shared';
import { seedBotsFromFile } from '../apps/agent/src/config-seed.js';

const logger = createLogger({ name: 'seed-test', level: 'silent' });

interface Row {
  id: string;
  name: string;
  username: string;
  serverHost: string;
  serverPort: number;
  serverVersion: string | null;
  authType: string;
  enabled: boolean;
  autoConnect: boolean;
  settings: Record<string, unknown>;
}

function makeRepo(seed: Row[] = []) {
  const rows = [...seed];
  const created: Record<string, unknown>[] = [];
  const updated: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let nextId = 0;

  const repo = {
    list: async () => rows.map((r) => ({ ...r })),
    create: async (input: Record<string, unknown>) => {
      nextId += 1;
      const row = {
        id: `id-${nextId}`,
        name: String(input['name']),
        username: String(input['username']),
        serverHost: String(input['serverHost']),
        serverPort: Number(input['serverPort']),
        serverVersion: (input['serverVersion'] as string | null) ?? null,
        authType: String(input['authType']),
        enabled: Boolean(input['enabled']),
        autoConnect: Boolean(input['autoConnect']),
        settings: (input['settings'] as Record<string, unknown>) ?? {},
      };
      rows.push(row);
      created.push(input);
      return { id: row.id };
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      updated.push({ id, patch });
      return row;
    },
  };

  return { repo, created, updated, rows };
}

const entry = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'mc-01',
  username: 'Bot01',
  serverHost: 'ignored.example.com',
  serverPort: 25565,
  serverVersion: '1.21.4',
  authType: 'offline',
  enabled: true,
  autoConnect: true,
  settings: {},
  ...over,
});

describe('bot config file seeding', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ukb-seed-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, body: unknown): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return file;
  }

  it('is a no-op when the config file is absent', async () => {
    const { repo, created } = makeRepo();
    const stats = await seedBotsFromFile(path.join(dir, 'missing.json'), { bots: repo }, logger);
    expect(stats).toEqual({ created: 0, updated: 0, unchanged: 0 });
    expect(created).toHaveLength(0);
  });

  it('creates bots from the file', async () => {
    const { repo, created } = makeRepo();
    const file = await write('bots.json', {
      bots: [entry(), entry({ name: 'mc-02', username: 'Bot02' })],
    });

    const stats = await seedBotsFromFile(file, { bots: repo }, logger);
    expect(stats.created).toBe(2);
    expect(created.map((c) => c['name'])).toEqual(['mc-01', 'mc-02']);
  });

  it('reports unchanged on a second identical run and creates nothing twice', async () => {
    const { repo, created } = makeRepo();
    const file = await write('bots.json', { bots: [entry()] });

    await seedBotsFromFile(file, { bots: repo }, logger);
    const second = await seedBotsFromFile(file, { bots: repo }, logger);

    expect(second).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect(created).toHaveLength(1);
  });

  it('updates only the fields that actually changed', async () => {
    const existing: Row = {
      id: 'id-existing',
      name: 'mc-01',
      username: 'Bot01',
      serverHost: 'new.example.com',
      serverPort: 25565,
      serverVersion: '1.21.4',
      authType: 'offline',
      enabled: true,
      autoConnect: true,
      settings: {},
    };
    const { repo, updated } = makeRepo([existing]);
    const file = await write('bots.json', { bots: [entry({ serverHost: 'new.example.com' })] });

    const stats = await seedBotsFromFile(file, { bots: repo }, logger);
    expect(stats).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect(updated).toHaveLength(0);
  });

  it('does not overwrite a server host edited outside the config file', async () => {
    const existing: Row = {
      id: 'id-existing',
      name: 'mc-01',
      username: 'Bot01',
      serverHost: 'edited-in-ui.example.com',
      serverPort: 25565,
      serverVersion: '1.21.4',
      authType: 'offline',
      enabled: true,
      autoConnect: true,
      settings: {},
    };
    const { repo, updated } = makeRepo([existing]);
    const file = await write('bots.json', { bots: [entry({ serverHost: 'ignored.example.com' })] });

    await seedBotsFromFile(file, { bots: repo }, logger);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.patch).toEqual({ serverHost: 'ignored.example.com' });
  });

  it('rejects malformed JSON with a descriptive error', async () => {
    const { repo } = makeRepo();
    const file = await write('bots.json', '{ not json');
    await expect(seedBotsFromFile(file, { bots: repo }, logger)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a file that fails schema validation', async () => {
    const { repo } = makeRepo();
    const file = await write('bots.json', {
      bots: [entry({ name: 'bad name!', username: 'way-too-long-username' })],
    });
    await expect(seedBotsFromFile(file, { bots: repo }, logger)).rejects.toThrow(/is invalid/);
  });

  it('treats a missing bots array as an empty config', async () => {
    const { repo } = makeRepo();
    const file = await write('bots.json', {});
    const stats = await seedBotsFromFile(file, { bots: repo }, logger);
    expect(stats).toEqual({ created: 0, updated: 0, unchanged: 0 });
  });

  it('does not log secret values when logging applied changes', async () => {
    const { repo } = makeRepo();
    const file = await write('bots.json', { bots: [entry({ authType: 'offline' })] });
    const info = vi.fn();
    const spyLogger = {
      ...logger,
      info,
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as typeof logger;

    await seedBotsFromFile(file, { bots: repo }, spyLogger);
    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).not.toMatch(/password|token|secret/i);
    expect(serialized).toContain('mc-01');
  });
});
