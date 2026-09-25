import { describe, expect, it } from 'vitest';
import { buildInventorySummary, verifyTransfer } from '@unionkitbot/shared';
import { verifySenderLoss } from '../apps/agent/src/delivery/delivery-service.js';

const summary = (slots: Array<[string, number]>) =>
  buildInventorySummary(slots.map(([name, count], index) => ({ slot: index, name, count })));

describe('delivery verification', () => {
  it('accepts when the sender lost exactly the expected items', () => {
    const before = summary([
      ['minecraft:bread', 32],
      ['iron_pickaxe', 1],
    ]);
    const after = summary([['iron_pickaxe', 1]]);
    const result = verifySenderLoss(before, after, [{ item: 'minecraft:bread', count: 32 }]);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('rejects when the sender still holds the items', () => {
    const before = summary([['bread', 32]]);
    const after = summary([['bread', 32]]);
    const result = verifySenderLoss(before, after, [{ item: 'bread', count: 32 }]);
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('expected to lose 32 bread');
  });

  it('rejects a partial transfer', () => {
    const before = summary([['bread', 32]]);
    const after = summary([['bread', 20]]);
    const result = verifySenderLoss(before, after, [{ item: 'bread', count: 32 }]);
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('lost 12');
  });

  it('handles multi-item kits and normalised names', () => {
    const before = summary([
      ['minecraft:bread', 32],
      ['minecraft:iron_pickaxe', 1],
    ]);
    const after = summary([]);
    const result = verifySenderLoss(before, after, [
      { item: 'bread', count: 32 },
      { item: 'iron_pickaxe', count: 1 },
    ]);
    expect(result.ok).toBe(true);
  });

  it('verifyTransfer requires the receiver to gain the items when observable', () => {
    const senderBefore = summary([['bread', 32]]);
    const senderAfter = summary([]);
    const receiverBefore = summary([]);
    const receiverAfter = summary([['bread', 32]]);
    expect(
      verifyTransfer(
        [{ item: 'bread', count: 32 }],
        senderBefore,
        senderAfter,
        receiverBefore,
        receiverAfter,
      ).ok,
    ).toBe(true);

    const badReceiver = summary([]);
    const failed = verifyTransfer(
      [{ item: 'bread', count: 32 }],
      senderBefore,
      senderAfter,
      receiverBefore,
      badReceiver,
    );
    expect(failed.ok).toBe(false);
    expect(failed.reasons.some((r) => r.includes('receiver gained'))).toBe(true);
  });
});
