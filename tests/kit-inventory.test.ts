import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  buildInventorySummary,
  countItem,
  hasAllRequirements,
  kitRequirements,
  missingRequirements,
  normalizeItemName,
  validateKit,
  type KitDefinition,
} from '@unionkitbot/shared';

describe('kit validation', () => {
  it('accepts a well formed kit and normalises item names', () => {
    const kit = validateKit({
      id: 'starter',
      name: 'Starter',
      items: [
        { item: 'minecraft:bread', count: 32 },
        { item: 'IRON_PICKAXE', count: 1 },
      ],
    });
    expect(kit.items).toEqual([
      { item: 'bread', count: 32 },
      { item: 'iron_pickaxe', count: 1 },
    ]);
    expect(kit.enabled).toBe(true);
  });

  it('merges duplicate items into a single requirement', () => {
    const kit = validateKit({
      id: 'dup',
      name: 'Dup',
      items: [
        { item: 'minecraft:bread', count: 10 },
        { item: 'bread', count: 5 },
      ],
    });
    expect(kit.items).toEqual([{ item: 'bread', count: 15 }]);
  });

  it('rejects malformed kits', () => {
    expect(() => validateKit(null)).toThrow(ValidationError);
    expect(() => validateKit({ name: 'x', items: [] })).toThrow(/kit\.id/);
    expect(() => validateKit({ id: 'x', name: 'x', items: [] })).toThrow(/non-empty/);
    expect(() => validateKit({ id: 'x', name: 'x', items: [{ item: 'bread', count: 0 }] })).toThrow(
      /positive integer/,
    );
    expect(() => validateKit({ id: 'x', name: 'x', items: [{ count: 1 }] })).toThrow(
      /item is required/,
    );
  });

  it('flattens multiple kits and rejects unknown/disabled kits', () => {
    const kits: KitDefinition[] = [
      { id: 'a', name: 'A', items: [{ item: 'bread', count: 8 }], enabled: true },
      {
        id: 'b',
        name: 'B',
        items: [
          { item: 'bread', count: 4 },
          { item: 'torch', count: 16 },
        ],
        enabled: true,
      },
      { id: 'off', name: 'Off', items: [{ item: 'sword', count: 1 }], enabled: false },
    ];
    expect(kitRequirements(kits, ['a', 'b'])).toEqual([
      { item: 'bread', count: 12 },
      { item: 'torch', count: 16 },
    ]);
    expect(() => kitRequirements(kits, ['nope'])).toThrow(/unknown kit/);
    expect(() => kitRequirements(kits, ['off'])).toThrow(/disabled/);
  });
});

describe('inventory validation', () => {
  const summary = buildInventorySummary([
    { slot: 36, name: 'minecraft:bread', count: 20 },
    { slot: 37, name: 'bread', count: 12 },
    { slot: 38, name: 'minecraft:iron_pickaxe', count: 1 },
    { slot: 39, name: null, count: 0 },
  ]);

  it('normalises names and skips empty slots', () => {
    expect(normalizeItemName('minecraft:Iron_Pickaxe')).toBe('iron_pickaxe');
    expect(summary.usedSlots).toBe(3);
    expect(summary.emptySlots).toBe(33);
  });

  it('counts stacked items across slots', () => {
    expect(countItem(summary, 'bread')).toBe(32);
    expect(countItem(summary, 'minecraft:bread')).toBe(32);
    expect(countItem(summary, 'diamond')).toBe(0);
  });

  it('computes missing requirements against real stock', () => {
    expect(hasAllRequirements(summary, [{ item: 'bread', count: 32 }])).toBe(true);
    expect(missingRequirements(summary, [{ item: 'bread', count: 40 }])).toEqual([
      { item: 'bread', count: 8 },
    ]);
    const missing = missingRequirements(summary, [
      { item: 'bread', count: 32 },
      { item: 'diamond', count: 5 },
    ]);
    expect(missing).toEqual([{ item: 'diamond', count: 5 }]);
  });
});
