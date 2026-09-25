import { describe, expect, it } from 'vitest';
import { ALLOWED_TRANSITIONS, StateMachine, isValidTransition } from '@unionkitbot/shared';

describe('state machine', () => {
  it('starts OFFLINE and records transitions', () => {
    const machine = new StateMachine();
    expect(machine.current).toBe('OFFLINE');
    expect(machine.transition('CONNECTING', 'test')).toBe(true);
    expect(machine.transition('SPAWNING', 'test')).toBe(true);
    expect(machine.transition('IDLE', 'test')).toBe(true);
    expect(machine.current).toBe('IDLE');
    expect(machine.getHistory()).toHaveLength(3);
  });

  it('refuses illegal transitions without throwing', () => {
    const machine = new StateMachine('OFFLINE');
    expect(machine.transition('DELIVERING', 'illegal')).toBe(false);
    expect(machine.current).toBe('OFFLINE');
  });

  it('permits recovery from every operational state', () => {
    for (const state of [
      'IDLE',
      'NAVIGATING',
      'DELIVERING',
      'SCANNING',
      'DEAD',
      'ERROR',
    ] as const) {
      expect(isValidTransition(state, 'RECOVERING')).toBe(true);
    }
  });

  it('notifies listeners and supports forced recovery transitions', () => {
    const machine = new StateMachine('OFFLINE');
    const seen: string[] = [];
    const off = machine.onChange((change) => seen.push(`${change.from}->${change.to}`));
    machine.transition('CONNECTING', 'x');
    machine.force('DELIVERING', 'recovery override');
    machine.force('IDLE', 'done');
    off();
    machine.transition('NAVIGATING', 'no listener');
    expect(seen).toEqual(['OFFLINE->CONNECTING', 'CONNECTING->DELIVERING', 'DELIVERING->IDLE']);
  });

  it('every state has a transition table entry', () => {
    for (const [state, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect(Array.isArray(targets), state).toBe(true);
      expect(targets.length).toBeGreaterThan(0);
    }
  });
});
