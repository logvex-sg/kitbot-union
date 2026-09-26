import { describe, expect, it } from 'vitest';
import {
  blockKind,
  buildScanResult,
  countContainers,
  formatContainerCounts,
  groupContainers,
  isWithinRadius,
  type RawStorageBlock,
} from '@unionkitbot/shared';

const block = (x: number, y: number, z: number, name = 'minecraft:chest'): RawStorageBlock => ({
  name,
  x,
  y,
  z,
});

describe('storage counting', () => {
  it('recognises supported storage blocks and ignores the rest', () => {
    expect(blockKind('minecraft:chest')).toBe('CHEST');
    expect(blockKind('barrel')).toBe('BARREL');
    expect(blockKind('minecraft:shulker_box')).toBe('SHULKER_BOX');
    expect(blockKind('minecraft:trapped_chest')).toBe('TRAPPED_CHEST');
    expect(blockKind('minecraft:stone')).toBeNull();
    expect(blockKind('minecraft:hopper')).toBeNull();
  });

  it('counts a lone chest as one container', () => {
    const containers = groupContainers([block(0, 64, 0)]);
    expect(containers).toHaveLength(1);
    expect(containers[0]?.kind).toBe('CHEST');
  });

  it('groups an adjacent pair into ONE double chest', () => {
    const containers = groupContainers([block(0, 64, 0), block(1, 64, 0)]);
    expect(containers).toHaveLength(1);
    expect(containers[0]?.kind).toBe('DOUBLE_CHEST');
  });

  it('groups along the z axis too', () => {
    const containers = groupContainers([block(5, 64, 5), block(5, 64, 6)]);
    expect(containers).toHaveLength(1);
    expect(containers[0]?.kind).toBe('DOUBLE_CHEST');
  });

  it('does NOT group diagonal or stacked chests', () => {
    expect(groupContainers([block(0, 64, 0), block(1, 64, 1)])).toHaveLength(2);
    expect(groupContainers([block(0, 64, 0), block(0, 65, 0)])).toHaveLength(2);
  });

  it('produces the documented 4 chests / 3 double chests / 2 barrels / 6 shulkers = 15 example', () => {
    const blocks: RawStorageBlock[] = [];
    // 4 single chests, isolated
    blocks.push(block(0, 64, 0), block(3, 64, 0), block(6, 64, 0), block(9, 64, 0));
    // 3 double chests (6 chest blocks)
    blocks.push(block(20, 64, 0), block(21, 64, 0));
    blocks.push(block(23, 64, 0), block(24, 64, 0));
    blocks.push(block(26, 64, 3), block(26, 64, 4));
    // 2 barrels
    blocks.push(block(0, 64, 10, 'minecraft:barrel'), block(0, 64, 12, 'minecraft:barrel'));
    // 6 shulker boxes
    for (let i = 0; i < 6; i += 1) blocks.push(block(i * 3, 70, 20, 'minecraft:shulker_box'));

    const containers = groupContainers(blocks);
    const counts = countContainers(containers);

    expect(counts['CHEST']).toBe(4);
    expect(counts['DOUBLE_CHEST']).toBe(3);
    expect(counts['BARREL']).toBe(2);
    expect(counts['SHULKER_BOX']).toBe(6);
    expect(containers).toHaveLength(15);

    const summary = formatContainerCounts(counts);
    expect(summary).toContain('4 chests');
    expect(summary).toContain('3 double chests');
    expect(summary).toContain('2 barrels');
    expect(summary).toContain('6 shulker boxes');
  });

  it('never double counts a chest as both single and double', () => {
    const containers = groupContainers([block(0, 64, 0), block(1, 64, 0), block(5, 64, 0)]);
    expect(containers).toHaveLength(2);
    expect(containers.filter((c) => c.kind === 'DOUBLE_CHEST')).toHaveLength(1);
    expect(containers.filter((c) => c.kind === 'CHEST')).toHaveLength(1);
  });

  it('building a scan result records metadata and a stable count', () => {
    const result = buildScanResult({
      botId: 'bot-1',
      dimension: 'overworld',
      origin: { x: 0, y: 64, z: 0 },
      radius: 8,
      blocks: [block(0, 64, 0), block(1, 64, 0)],
      inspected: 1,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(result.botId).toBe('bot-1');
    expect(result.dimension).toBe('overworld');
    expect(result.radius).toBe(8);
    expect(result.logicalContainerCount).toBe(1);
    expect(result.counts['DOUBLE_CHEST']).toBe(1);
    expect(result.inspected).toBe(1);
    expect(result.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(result.scanId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('radius test is inclusive of the requested distance', () => {
    expect(isWithinRadius({ x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }, 8)).toBe(true);
    expect(isWithinRadius({ x: 0, y: 64, z: 0 }, { x: 50, y: 64, z: 0 }, 8)).toBe(false);
  });
});
