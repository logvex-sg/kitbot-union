import type { BotState } from './types.js';

/**
 * Power saving mode.
 *
 * When the bot is idle, non-essential periodic work is slowed down: scans, telemetry and
 * WebSocket broadcasts. The bot is never disconnected, and the critical paths below are
 * exempt so a delivery in flight, a TPA request, a death or a disconnect is always handled
 * at full speed.
 */

export interface PowerSavingConfig {
  enabled: boolean;
  /** Scan interval applied while idle, in seconds. */
  idleScanIntervalSeconds: number;
  /** Telemetry/heartbeat interval applied while idle, in seconds. */
  idleTelemetryIntervalSeconds: number;
  /** Also slow chat polling and cache refreshes. */
  aggressive: boolean;
}

export const DEFAULT_POWER_SAVING: PowerSavingConfig = {
  enabled: true,
  idleScanIntervalSeconds: 30,
  idleTelemetryIntervalSeconds: 15,
  aggressive: false,
};

/** States in which throttling is allowed. Anything else runs at normal speed. */
const IDLE_STATES: readonly BotState[] = ['IDLE', 'OFFLINE'];

/**
 * Task types that must never be throttled. Recovery, connection handling and delivery are
 * always processed immediately regardless of power saving.
 */
export const CRITICAL_TASK_TYPES: readonly string[] = [
  'CONNECT',
  'RECONNECT',
  'DEATH_RECOVERY',
  'TPA_HANDLING',
  'DELIVERY',
];

export interface ThrottleInput {
  config: PowerSavingConfig;
  state: BotState;
  /** True while a task is running, which always means full speed. */
  hasActiveTask: boolean;
  /** True while a TPA request is outstanding. */
  hasPendingTpa: boolean;
}

export interface ThrottleDecision {
  throttled: boolean;
  reason: string;
  /** Multiplier applied to interval-based work; 1 means normal speed. */
  scanIntervalMs: number;
  telemetryIntervalMs: number;
}

export function baseScanIntervalMs(config: PowerSavingConfig): number {
  return Math.max(1, config.idleScanIntervalSeconds) * 1000;
}

export function baseTelemetryIntervalMs(config: PowerSavingConfig): number {
  return Math.max(1, config.idleTelemetryIntervalSeconds) * 1000;
}

/**
 * Decides whether the bot should be in low-power mode right now.
 *
 * Throttling requires ALL of: power saving enabled, an idle state, no active task and no
 * pending TPA. Any doubt resolves to full speed, because a missed delivery is far more
 * expensive than a few extra scans.
 */
export function decideThrottle(input: ThrottleInput): ThrottleDecision {
  const { config, state, hasActiveTask, hasPendingTpa } = input;
  if (!config.enabled) {
    return {
      throttled: false,
      reason: 'power saving disabled',
      scanIntervalMs: 0,
      telemetryIntervalMs: 0,
    };
  }
  if (hasActiveTask) {
    return {
      throttled: false,
      reason: 'a task is running',
      scanIntervalMs: 0,
      telemetryIntervalMs: 0,
    };
  }
  if (hasPendingTpa) {
    return {
      throttled: false,
      reason: 'a tpa request is outstanding',
      scanIntervalMs: 0,
      telemetryIntervalMs: 0,
    };
  }
  if (!IDLE_STATES.includes(state)) {
    return {
      throttled: false,
      reason: `state ${state} is not idle`,
      scanIntervalMs: 0,
      telemetryIntervalMs: 0,
    };
  }
  return {
    throttled: true,
    reason: `idle in ${state}; slowing periodic work`,
    scanIntervalMs: baseScanIntervalMs(config),
    telemetryIntervalMs: baseTelemetryIntervalMs(config),
  };
}

/**
 * True when a task must bypass throttling. Used by the runtime so a CRITICAL task is never
 * delayed by a slow interval.
 */
export function mustRunImmediately(taskType: string): boolean {
  return CRITICAL_TASK_TYPES.includes(taskType);
}

/**
 * Whether a WebSocket broadcast may be coalesced under aggressive power saving.
 * State changes and terminal task events always broadcast immediately.
 */
export function canCoalesceBroadcast(
  type: string,
  config: PowerSavingConfig,
): boolean {
  if (!config.enabled || !config.aggressive) return false;
  const alwaysImmediate = new Set([
    'bot:state',
    'bot:death',
    'bot:disconnected',
    'bot:connected',
    'bot:error',
    'bot:delivery',
    'bot:tpa',
  ]);
  return !alwaysImmediate.has(type);
}
