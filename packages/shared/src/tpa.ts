import type { TpaDecision, TpaSettings } from './types.js';

export interface TpaRequest {
  id: string;
  player: string;
  playerUuid: string | null;
  at?: number;
}
export interface TpaEvaluation {
  accepted: boolean;
  reason: string;
}

export interface TpaEngineState {
  trusted: Set<string>;
  blocked: Set<string>;
  pending: Map<string, number>;
  lastDecisionAt: Map<string, number>;
}

export function createTpaEngineState(): TpaEngineState {
  return { trusted: new Set(), blocked: new Set(), pending: new Map(), lastDecisionAt: new Map() };
}

export function normalizePlayerName(player: string): string {
  return player.trim().toLowerCase();
}

/**
 * Deterministic TPA decision. Precedence:
 *   blocked list > global disable > per-mode rules.
 * Every branch returns an explicit reason which the caller always logs.
 */
export function evaluateTpa(
  request: TpaRequest,
  settings: TpaSettings,
  state: TpaEngineState,
  now = Date.now(),
): TpaEvaluation {
  const player = normalizePlayerName(request.player);
  const blocked = new Set([...settings.blockedPlayers, ...state.blocked].map(normalizePlayerName));
  const trusted = new Set([...settings.trustedPlayers, ...state.trusted].map(normalizePlayerName));

  if (blocked.has(player)) return { accepted: false, reason: 'player is on the blocked list' };
  if (!settings.enabled || settings.mode === 'DISABLED') {
    return { accepted: false, reason: 'tpa handling is disabled' };
  }

  const lastDecision = state.lastDecisionAt.get(player);
  if (
    settings.cooldownMs > 0 &&
    lastDecision !== undefined &&
    now - lastDecision < settings.cooldownMs
  ) {
    return { accepted: false, reason: 'player is on cooldown' };
  }
  if (state.pending.size >= settings.maxPending) {
    return { accepted: false, reason: `too many pending requests (max ${settings.maxPending})` };
  }

  switch (settings.mode) {
    case 'TRUSTED_ONLY':
      return trusted.has(player)
        ? { accepted: true, reason: 'player is trusted' }
        : { accepted: false, reason: 'player is not in the trusted list' };
    case 'ALLOW_LIST':
      return settings.trustedPlayers.map(normalizePlayerName).includes(player)
        ? { accepted: true, reason: 'player is on the allow list' }
        : { accepted: false, reason: 'player is not on the allow list' };
    case 'MANUAL':
      return { accepted: false, reason: 'manual mode: awaiting operator decision' };
    case 'CUSTOM_RULES': {
      const rule = settings.customRules[request.player] ?? settings.customRules[player];
      if (rule === true) return { accepted: true, reason: 'matched custom allow rule' };
      if (rule === false) return { accepted: false, reason: 'matched custom deny rule' };
      if (trusted.has(player))
        return { accepted: true, reason: 'player is trusted (custom fallback)' };
      return { accepted: false, reason: 'no custom rule matched' };
    }
    default:
      return { accepted: false, reason: 'unsupported tpa mode' };
  }
}

export function openRequest(state: TpaEngineState, request: TpaRequest, now = Date.now()): boolean {
  if (state.pending.has(request.id)) return false;
  state.pending.set(request.id, now);
  return true;
}

export function recordDecision(
  state: TpaEngineState,
  decision: TpaDecision,
  now = Date.now(),
): void {
  state.pending.delete(decision.requestId);
  state.lastDecisionAt.set(normalizePlayerName(decision.player), now);
}

export function expireRequests(
  state: TpaEngineState,
  timeoutMs: number,
  now = Date.now(),
): string[] {
  const expired: string[] = [];
  for (const [id, at] of state.pending) {
    if (now - at > timeoutMs) {
      expired.push(id);
      state.pending.delete(id);
    }
  }
  return expired;
}
