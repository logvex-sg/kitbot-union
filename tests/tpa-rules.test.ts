import { describe, expect, it } from 'vitest';
import {
  createTpaEngineState,
  evaluateTpa,
  expireRequests,
  openRequest,
  recordDecision,
  type TpaSettings,
} from '@unionkitbot/shared';

const base = (patch: Partial<TpaSettings> = {}): TpaSettings => ({
  enabled: true,
  mode: 'TRUSTED_ONLY',
  timeoutMs: 60_000,
  trustedPlayers: [],
  blockedPlayers: [],
  customRules: {},
  cooldownMs: 0,
  maxPending: 5,
  ...patch,
});

describe('tpa rules', () => {
  it('DISABLED rejects everything', () => {
    const result = evaluateTpa(
      { id: '1', player: 'steve', playerUuid: null },
      base({ mode: 'DISABLED' }),
      createTpaEngineState(),
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('disabled');
  });

  it('blocked list always wins, even over the trusted list', () => {
    const result = evaluateTpa(
      { id: '1', player: 'Griefer', playerUuid: null },
      base({ trustedPlayers: ['Griefer'], blockedPlayers: ['griefer'] }),
      createTpaEngineState(),
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('blocked');
  });

  it('TRUSTED_ONLY accepts only trusted players, case-insensitively', () => {
    const state = createTpaEngineState();
    const settings = base({ trustedPlayers: ['alice'] });
    expect(
      evaluateTpa({ id: '1', player: 'Alice', playerUuid: null }, settings, state).accepted,
    ).toBe(true);
    expect(
      evaluateTpa({ id: '2', player: 'bob', playerUuid: null }, settings, state).accepted,
    ).toBe(false);
  });

  it('ALLOW_LIST ignores runtime trust and uses only the configured list', () => {
    const state = createTpaEngineState();
    state.trusted.add('mallory');
    expect(
      evaluateTpa(
        { id: '1', player: 'mallory', playerUuid: null },
        base({ mode: 'ALLOW_LIST', trustedPlayers: [] }),
        state,
      ).accepted,
    ).toBe(false);
    expect(
      evaluateTpa(
        { id: '2', player: 'alice', playerUuid: null },
        base({ mode: 'ALLOW_LIST', trustedPlayers: ['alice'] }),
        state,
      ).accepted,
    ).toBe(true);
  });

  it('MANUAL never auto-accepts and defers to the operator', () => {
    const result = evaluateTpa(
      { id: '1', player: 'alice', playerUuid: null },
      base({ mode: 'MANUAL', trustedPlayers: ['alice'] }),
      createTpaEngineState(),
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('manual');
  });

  it('CUSTOM_RULES honours explicit allow/deny and falls back to trusted', () => {
    const settings = base({
      mode: 'CUSTOM_RULES',
      customRules: { alice: true, bob: false },
      trustedPlayers: ['carol'],
    });
    const state = createTpaEngineState();
    expect(
      evaluateTpa({ id: '1', player: 'alice', playerUuid: null }, settings, state).accepted,
    ).toBe(true);
    expect(
      evaluateTpa({ id: '2', player: 'bob', playerUuid: null }, settings, state).accepted,
    ).toBe(false);
    expect(
      evaluateTpa({ id: '3', player: 'carol', playerUuid: null }, settings, state).accepted,
    ).toBe(true);
    expect(
      evaluateTpa({ id: '4', player: 'dave', playerUuid: null }, settings, state).accepted,
    ).toBe(false);
  });

  it('enforces cooldown after a decision', () => {
    const settings = base({ cooldownMs: 10_000, trustedPlayers: ['alice'] });
    const state = createTpaEngineState();
    const now = 1_000_000;
    openRequest(state, { id: '1', player: 'alice', playerUuid: null }, now);
    const first = evaluateTpa({ id: '1', player: 'alice', playerUuid: null }, settings, state, now);
    expect(first.accepted).toBe(true);
    recordDecision(
      state,
      {
        requestId: '1',
        player: 'alice',
        playerUuid: null,
        accepted: true,
        mode: 'TRUSTED_ONLY',
        reason: first.reason,
        at: new Date().toISOString(),
      },
      now,
    );
    const second = evaluateTpa(
      { id: '2', player: 'alice', playerUuid: null },
      settings,
      state,
      now + 1000,
    );
    expect(second.accepted).toBe(false);
    expect(second.reason).toContain('cooldown');
    const third = evaluateTpa(
      { id: '3', player: 'alice', playerUuid: null },
      settings,
      state,
      now + 11_000,
    );
    expect(third.accepted).toBe(true);
  });

  it('rejects when the pending queue is full', () => {
    const settings = base({ maxPending: 1, trustedPlayers: ['alice'] });
    const state = createTpaEngineState();
    openRequest(state, { id: 'a', player: 'someone', playerUuid: null });
    const result = evaluateTpa({ id: 'b', player: 'alice', playerUuid: null }, settings, state);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('pending');
  });

  it('expires stale pending requests', () => {
    const state = createTpaEngineState();
    openRequest(state, { id: 'old', player: 'alice', playerUuid: null }, 1000);
    openRequest(state, { id: 'new', player: 'bob', playerUuid: null }, 50_000);
    const expired = expireRequests(state, 10_000, 60_000);
    expect(expired).toEqual(['old']);
    expect(state.pending.has('new')).toBe(true);
  });

  it('always returns a non-empty reason for logging', () => {
    const modes = ['DISABLED', 'TRUSTED_ONLY', 'ALLOW_LIST', 'MANUAL', 'CUSTOM_RULES'] as const;
    for (const mode of modes) {
      const result = evaluateTpa(
        { id: '1', player: 'nobody', playerUuid: null },
        base({ mode }),
        createTpaEngineState(),
      );
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
