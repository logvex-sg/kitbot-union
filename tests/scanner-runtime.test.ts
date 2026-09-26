import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { createLogger, withTimeout } from '@unionkitbot/shared';
import { AgentEventEmitter } from '../apps/agent/src/events.js';
import { StorageScanner } from '../apps/agent/src/storage/scanner.js';

const logger = createLogger({ name: 'scanner-test', level: 'silent' });

/**
 * mineflayer's real blockAt implementation calls .floored() on the position argument,
 * so any implementation that hands it a plain {x,y,z} object crashes at runtime. This
 * stand-in enforces that contract instead of tolerating it.
 */
function createBot(blocks: Map<string, { name: string }>) {
  const seenPositions: unknown[] = [];
  const bot = {
    blockAt(point: unknown) {
      seenPositions.push(point);
      if (typeof (point as { floored?: unknown }).floored !== 'function') {
        throw new TypeError('pos.floored is not a function');
      }
      const p = (point as Vec3).floored();
      return blocks.get(`${p.x},${p.y},${p.z}`) ?? null;
    },
  } as unknown as Bot;
  return { bot, seenPositions };
}

function makeScanner(bot: Bot) {
  return new StorageScanner({
    botId: 'bot-1',
    logger,
    events: new AgentEventEmitter(),
    getBot: () => bot,
    getDimension: () => 'overworld',
  });
}

describe('storage scanner against a Vec3-strict bot', () => {
  it('scans without the pos.floored runtime failure', async () => {
    const blocks = new Map([
      ['10,64,10', { name: 'minecraft:chest' }],
      ['11,64,10', { name: 'minecraft:chest' }],
      ['10,65,10', { name: 'minecraft:barrel' }],
    ]);
    const { bot } = createBot(blocks);

    const { result } = await makeScanner(bot).scan(
      { x: 10, y: 64, z: 10 },
      { radius: 4, inspectContents: false },
    );

    expect(result.counts['DOUBLE_CHEST']).toBe(1);
    expect(result.counts['BARREL']).toBe(1);
    expect(result.logicalContainerCount).toBe(2);
  });

  it('passes a real Vec3 instance to blockAt for every probed position', async () => {
    const { bot, seenPositions } = createBot(new Map());
    await makeScanner(bot).scan({ x: 0, y: 64, z: 0 }, { radius: 1, inspectContents: false });

    expect(seenPositions.length).toBeGreaterThan(0);
    expect(seenPositions.every((p) => p instanceof Vec3)).toBe(true);
  });

  it('returns an empty scan instead of throwing when the bot is disconnected', async () => {
    const scanner = new StorageScanner({
      botId: 'bot-1',
      logger,
      events: new AgentEventEmitter(),
      getBot: () => null,
      getDimension: () => 'overworld',
    });

    const { result } = await scanner.scan(
      { x: 0, y: 64, z: 0 },
      { radius: 4, inspectContents: true },
    );
    expect(result.logicalContainerCount).toBe(0);
    expect(result.counts).toEqual({});
  });

  it('does not attempt container inspection when inspectContents is false', async () => {
    const openContainer = vi.fn();
    const bot = {
      blockAt: (point: Vec3) => ({ name: 'minecraft:chest', position: point }),
      openContainer,
    } as unknown as Bot;

    await makeScanner(bot).scan({ x: 5, y: 64, z: 5 }, { radius: 1, inspectContents: false });
    expect(openContainer).not.toHaveBeenCalled();
  });

  it('reports an inspection failure instead of fabricating contents', async () => {
    const bot = {
      blockAt: (point: Vec3) => {
        const p = point.floored();
        return p.x === 5 && p.y === 64 && p.z === 5
          ? { name: 'minecraft:chest', position: point }
          : null;
      },
      openContainer: async () => {
        throw new Error('container is locked');
      },
    } as unknown as Bot;

    const { result, contents } = await makeScanner(bot).scan(
      { x: 5, y: 64, z: 5 },
      { radius: 1, inspectContents: true },
    );

    expect(result.counts['CHEST']).toBe(1);
    expect(contents.size).toBe(0);
  });

  it('never hangs when openContainer resolves without ever settling', async () => {
    // Regression: a scan radius normally exceeds interaction reach, and mineflayer's
    // openContainer never settles for such a block, which stalled the scan task forever.
    const bot = {
      entity: { position: new Vec3(5, 64, 5) },
      blockAt: (point: Vec3) => {
        const p = point.floored();
        return p.x === 5 && p.y === 64 && p.z === 5
          ? { name: 'minecraft:chest', position: point }
          : null;
      },
      openContainer: () => new Promise(() => {}),
    } as unknown as Bot;

    const { result, contents } = await withTimeout(
      makeScanner(bot).scan({ x: 5, y: 64, z: 5 }, { radius: 1, inspectContents: true }),
      20_000,
      'scan',
    );

    expect(result.counts['CHEST']).toBe(1);
    expect(contents.size).toBe(0);
  });

  it('skips inspection for containers beyond interaction reach', async () => {
    const openContainer = vi.fn(async () => {
      throw new Error('should not be called for an unreachable chest');
    });
    const bot = {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt: (point: Vec3) => {
        const p = point.floored();
        return p.x === 30 && p.y === 64 && p.z === 30
          ? { name: 'minecraft:chest', position: point }
          : null;
      },
      openContainer,
    } as unknown as Bot;

    const { result } = await makeScanner(bot).scan(
      { x: 30, y: 64, z: 30 },
      { radius: 1, inspectContents: true },
    );

    expect(result.counts['CHEST']).toBe(1);
    expect(openContainer).not.toHaveBeenCalled();
  });
});
