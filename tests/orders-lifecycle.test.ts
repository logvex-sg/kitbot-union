import { describe, expect, it } from 'vitest';
import {
  ORDER_STATES,
  ReservationLedger,
  isValidOrderTransition,
  isTerminalOrderState,
  type OrderState,
  type Reservation,
} from '@unionkitbot/shared';

/**
 * Covers the order state machine and the item reservation ledger. Both are pure logic, so
 * they are exercised directly rather than through the runtime.
 */
describe('order state machine', () => {
  it('allows the documented happy path end to end', () => {
    const happyPath: OrderState[] = [
      'ORDER_RECEIVED',
      'VALIDATING',
      'RESERVING_ITEMS',
      'NAVIGATING_TO_TPA_POINT',
      'REQUESTING_TPA',
      'WAITING_FOR_TPA',
      'TELEPORT_WAIT',
      'LOCATING_PLAYER',
      'DELIVERING',
      'VERIFYING_DELIVERY',
      'RETURNING_TO_PACK_AREA',
      'COMPLETED',
    ];

    for (let i = 0; i < happyPath.length - 1; i += 1) {
      expect(
        isValidOrderTransition(happyPath[i]!, happyPath[i + 1]!),
        `${happyPath[i]} -> ${happyPath[i + 1]}`,
      ).toBe(true);
    }
  });

  it('refuses to skip a phase', () => {
    expect(isValidOrderTransition('ORDER_RECEIVED', 'DELIVERING')).toBe(false);
    expect(isValidOrderTransition('VALIDATING', 'COMPLETED')).toBe(false);
  });

  it('lets any non-terminal state fail or be cancelled', () => {
    for (const state of ORDER_STATES) {
      if (isTerminalOrderState(state)) continue;
      expect(isValidOrderTransition(state, 'FAILED'), state).toBe(true);
      expect(isValidOrderTransition(state, 'CANCELLED'), state).toBe(true);
    }
  });

  it('treats terminal states as sinks', () => {
    for (const terminal of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      expect(isTerminalOrderState(terminal)).toBe(true);
      for (const target of ORDER_STATES) {
        if (target === terminal) continue;
        expect(isValidOrderTransition(terminal, target), `${terminal} -> ${target}`).toBe(false);
      }
    }
  });
});

describe('reservation ledger', () => {
  const reservation = (
    orderId: string,
    botId: string,
    items: Array<{ item: string; count: number }>,
  ): Reservation => ({ id: `res-${orderId}`, orderId, botId, items, at: new Date().toISOString() });

  it('reports what another order holds on the same bot, independent of the query items', () => {
    const ledger = new ReservationLedger();
    ledger.hydrate(reservation('order-a', 'bot-1', [{ item: 'diamond', count: 5 }]));

    expect(ledger.reservedByOthers('bot-1', [{ item: 'iron_ingot', count: 1 }], 'order-b')).toEqual([
      { item: 'diamond', count: 5 },
    ]);
  });

  it('reports items held by a different order on the same bot', () => {
    const ledger = new ReservationLedger();
    ledger.hydrate(reservation('order-a', 'bot-1', [{ item: 'diamond', count: 5 }]));

    const reserved = ledger.reservedByOthers('bot-1', [{ item: 'diamond', count: 2 }], 'order-b');
    expect(reserved).toEqual([{ item: 'diamond', count: 5 }]);
  });

  it('ignores reservations belonging to the requesting order', () => {
    const ledger = new ReservationLedger();
    ledger.hydrate(reservation('order-a', 'bot-1', [{ item: 'diamond', count: 5 }]));

    expect(ledger.reservedByOthers('bot-1', [{ item: 'diamond', count: 5 }], 'order-a')).toEqual(
      [],
    );
  });

  it('ignores reservations on another bot', () => {
    const ledger = new ReservationLedger();
    ledger.hydrate(reservation('order-a', 'bot-2', [{ item: 'diamond', count: 5 }]));

    expect(ledger.reservedByOthers('bot-1', [{ item: 'diamond', count: 5 }], 'order-b')).toEqual(
      [],
    );
  });

  it('sums reservations from several orders for the same item', () => {
    const ledger = new ReservationLedger();
    ledger.hydrate(reservation('order-a', 'bot-1', [{ item: 'diamond', count: 5 }]));
    ledger.hydrate(reservation('order-b', 'bot-1', [{ item: 'diamond', count: 3 }]));

    expect(ledger.reservedByOthers('bot-1', [{ item: 'diamond', count: 1 }], 'order-c')).toEqual([
      { item: 'diamond', count: 8 },
    ]);
  });

  it('drops a released reservation', () => {
    const ledger = new ReservationLedger();
    ledger.hydrate(reservation('order-a', 'bot-1', [{ item: 'diamond', count: 5 }]));
    ledger.release('order-a');

    expect(ledger.reservedByOthers('bot-1', [{ item: 'diamond', count: 1 }], 'order-b')).toEqual(
      [],
    );
  });

  it('matches item names case- and format-insensitively', () => {
    const ledger = new ReservationLedger();
    ledger.hydrate(reservation('order-a', 'bot-1', [{ item: 'Diamond', count: 4 }]));

    const reserved = ledger.reservedByOthers('bot-1', [{ item: 'diamond', count: 1 }], 'order-b');
    expect(reserved.map((r) => r.count)).toEqual([4]);
  });
});
