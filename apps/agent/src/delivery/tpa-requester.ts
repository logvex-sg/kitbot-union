import {
  sleep,
  type CancelToken,
  type Logger,
  type OutgoingTpaSettings,
} from '@unionkitbot/shared';
import { stripFormatting } from '@unionkitbot/shared';
import type { AgentEventEmitter } from '../events.js';

/**
 * Outgoing TPA requests.
 *
 * The bot asks a server to teleport it to a recipient, then waits for the server to say
 * whether the request was accepted. Outcomes are parsed from ordinary chat lines, so the
 * patterns are deliberately broad and every unmatched line is simply ignored: a false
 * negative costs a retry, whereas a false positive would make the bot teleport early.
 */

export const TPA_OUTCOMES = ['ACCEPTED', 'REJECTED', 'EXPIRED', 'TIMEOUT'] as const;
export type TpaOutcome = (typeof TPA_OUTCOMES)[number];

/**
 * Accepted-request patterns, ordered most specific first.
 *
 * `{player}` is replaced with the escaped recipient name when a pattern is used, so a
 * server that names the teleporting player is matched precisely rather than loosely.
 */
export const TPA_ACCEPT_PATTERNS: readonly RegExp[] = [
  /\bteleport(?:ing|ed)?\s+(?:you\s+)?to\s+\w{3,16}\b/i,
  /\bhas\s+accepted\s+your\s+(?:teleport|tpa)\s+request\b/i,
  /\byou\s+have\s+been\s+teleported\s+to\b/i,
  /\bteleporting\s+to\s+\w{3,16}\b/i,
  /\baccepted\s+your\s+request\b/i,
];

export const TPA_REJECT_PATTERNS: readonly RegExp[] = [
  /\brejected\s+your\s+(?:teleport|tpa)\s+request\b/i,
  /\b(?:has|have)\s+denied\s+your\s+(?:teleport|tpa)\s+request\b/i,
  /\byour\s+(?:teleport|tpa)\s+request\s+was\s+denied\b/i,
  /\brequest\s+denied\b/i,
];

export const TPA_EXPIRE_PATTERNS: readonly RegExp[] = [
  /\byour\s+(?:teleport|tpa)\s+request\s+(?:to\s+\w{3,16}\s+)?(?:has\s+)?expired\b/i,
  /\b(?:teleport|tpa)\s+request\s+timed?\s*out\b/i,
];

/** Classifies a chat line into a TPA outcome, or null when it is unrelated. */
export function classifyTpaOutcome(rawLine: string): TpaOutcome | null {
  const line = stripFormatting(String(rawLine ?? ''));
  if (line.length === 0) return null;
  for (const pattern of TPA_REJECT_PATTERNS) if (pattern.test(line)) return 'REJECTED';
  for (const pattern of TPA_EXPIRE_PATTERNS) if (pattern.test(line)) return 'EXPIRED';
  for (const pattern of TPA_ACCEPT_PATTERNS) if (pattern.test(line)) return 'ACCEPTED';
  return null;
}

/** Renders the configured command template for a recipient. */
export function buildTpaCommand(template: string, player: string): string {
  const safePlayer = player.trim();
  if (template.includes('{player}')) return template.split('{player}').join(safePlayer);
  // A template without a placeholder still needs the target appended, otherwise the
  // request would be addressed to nobody.
  return `${template.trim()} ${safePlayer}`.trim();
}

export interface OutgoingTpaOptions {
  botId: string;
  logger: Logger;
  events: AgentEventEmitter;
  getSettings: () => OutgoingTpaSettings;
  /** Sends a chat line, i.e. `bot.chat`. */
  say: (message: string) => void;
  /** Subscribes to every inbound chat line; returns an unsubscribe function. */
  onChat: (handler: (line: string) => void) => () => void;
  isConnected: () => boolean;
}

export interface TpaRequestResult {
  outcome: TpaOutcome;
  attempts: number;
  command: string | null;
  elapsedMs: number;
  reason: string;
}

/**
 * Drives one outgoing TPA request at a time.
 *
 * Only one request may be outstanding, which is what prevents the bot from spamming a
 * server with `/tpa`; a second request is refused rather than queued so the caller can
 * decide whether to abandon the delivery.
 */
export class TpaRequester {
  private readonly options: OutgoingTpaOptions;
  private pending: {
    player: string;
    resolve: (outcome: TpaOutcome) => void;
  } | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: OutgoingTpaOptions) {
    this.options = options;
    this.unsubscribe = options.onChat((line) => this.observe(line));
  }

  private observe(line: string): void {
    if (!this.pending) return;
    const outcome = classifyTpaOutcome(line);
    if (!outcome) return;
    const resolve = this.pending.resolve;
    this.pending = null;
    resolve(outcome);
  }

  get isPending(): boolean {
    return this.pending !== null;
  }

  /**
   * Sends the configured TPA command and waits for an outcome.
   *
   * Retries re-send the command, each with its own timeout, and never run concurrently
   * with an earlier attempt. A disconnect resolves the request as TIMEOUT so the caller
   * can move into recovery instead of waiting out the full timeout.
   */
  async request(player: string, token?: CancelToken): Promise<TpaRequestResult> {
    const settings = this.options.getSettings();
    const startedAt = Date.now();
    const command = buildTpaCommand(settings.command, player);

    if (!settings.enabled) {
      return {
        outcome: 'TIMEOUT',
        attempts: 0,
        command: null,
        elapsedMs: 0,
        reason: 'outgoing tpa is disabled',
      };
    }
    if (this.pending) {
      return {
        outcome: 'TIMEOUT',
        attempts: 0,
        command: null,
        elapsedMs: 0,
        reason: 'another tpa request is already outstanding',
      };
    }

    const maxAttempts = Math.max(1, settings.maxRetries);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (token?.isCancelled) {
        return {
          outcome: 'TIMEOUT',
          attempts: attempt - 1,
          command,
          elapsedMs: Date.now() - startedAt,
          reason: 'cancelled',
        };
      }
      if (!this.options.isConnected()) {
        return {
          outcome: 'TIMEOUT',
          attempts: attempt - 1,
          command,
          elapsedMs: Date.now() - startedAt,
          reason: 'bot is not connected',
        };
      }

      this.options.events.emit(
        'bot:tpa',
        `requesting tpa to ${player} (attempt ${attempt}/${maxAttempts})`,
        { player, attempt, command, direction: 'outgoing' },
        { botId: this.options.botId },
      );
      this.options.say(command);

      const outcome = await this.waitForOutcome(
        player,
        settings.timeoutSeconds * 1000,
        token,
      );
      if (outcome === 'ACCEPTED' || outcome === 'REJECTED' || outcome === 'EXPIRED') {
        this.options.events.emit(
          'bot:tpa',
          `tpa to ${player} ${outcome.toLowerCase()}`,
          { player, attempt, command, outcome, direction: 'outgoing' },
          {
            botId: this.options.botId,
            severity: outcome === 'ACCEPTED' ? 'info' : 'warn',
          },
        );
        return {
          outcome,
          attempts: attempt,
          command,
          elapsedMs: Date.now() - startedAt,
          reason: `server reported ${outcome.toLowerCase()}`,
        };
      }
      // Timeout on this attempt: retry with backoff unless it was the last one.
      if (attempt < maxAttempts) {
        await sleep(Math.min(1_000 * attempt, 5_000));
      }
    }

    this.options.events.emit(
      'bot:tpa',
      `tpa to ${player} timed out after ${maxAttempts} attempt(s)`,
      { player, attempts: maxAttempts, command, outcome: 'TIMEOUT', direction: 'outgoing' },
      { botId: this.options.botId, severity: 'warn' },
    );
    return {
      outcome: 'TIMEOUT',
      attempts: maxAttempts,
      command,
      elapsedMs: Date.now() - startedAt,
      reason: 'no response from the server within the configured timeout',
    };
  }

  /** Waits for `observe` to resolve the request, or for the per-attempt timeout. */
  private waitForOutcome(
    player: string,
    timeoutMs: number,
    token?: CancelToken,
  ): Promise<TpaOutcome> {
    return new Promise<TpaOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: TpaOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        resolve(outcome);
      };
      const unsubscribe = token?.onCancel(() => {
        this.pending = null;
        finish('TIMEOUT');
      });
      this.pending = { player, resolve: finish };
      const timer = setTimeout(() => {
        this.pending = null;
        finish('TIMEOUT');
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  /** Abandons any outstanding request, e.g. because the delivery was cancelled. */
  cancel(): void {
    if (this.pending) {
      const resolve = this.pending.resolve;
      this.pending = null;
      resolve('TIMEOUT');
    }
  }

  dispose(): void {
    this.cancel();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
