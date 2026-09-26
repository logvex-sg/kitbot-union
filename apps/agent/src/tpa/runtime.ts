import { randomUUID } from 'node:crypto';
import {
  createTpaEngineState,
  evaluateTpa,
  expireRequests,
  openRequest,
  recordDecision,
  type Logger,
  type TpaDecision,
  type TpaEngineState,
  type TpaSettings,
} from '@unionkitbot/shared';
import type { EventRepository } from '@unionkitbot/database';
import type { AgentEventEmitter } from '../events.js';

export interface TpaRuntimeOptions {
  botId: string;
  logger: Logger;
  events: AgentEventEmitter;
  eventsRepository: EventRepository;
  getSettings: () => TpaSettings;
  /** Called when a request is accepted so the bot can act on it (e.g. teleport accept). */
  onAccepted?: (decision: TpaDecision) => void | Promise<void>;
  onRejected?: (decision: TpaDecision) => void | Promise<void>;
  say?: (message: string) => void;
}

/**
 * Every TPA request produces exactly one logged decision, regardless of outcome.
 * The rules are deterministic; there is no path where chat content directly triggers
 * a Minecraft action without passing through `evaluateTpa`.
 */
export class TpaRuntime {
  readonly state: TpaEngineState;
  private readonly options: TpaRuntimeOptions;
  private readonly decisions: TpaDecision[] = [];
  private sweeper: NodeJS.Timeout | null = null;

  constructor(options: TpaRuntimeOptions) {
    this.options = options;
    this.state = createTpaEngineState();
    this.sweeper = setInterval(() => {
      this.expire();
    }, 5_000);
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
  }

  setTrusted(player: string, trusted: boolean): void {
    const key = player.toLowerCase();
    if (trusted) {
      this.state.trusted.add(key);
      this.state.blocked.delete(key);
    } else {
      this.state.trusted.delete(key);
    }
  }

  setBlocked(player: string, blocked: boolean): void {
    const key = player.toLowerCase();
    if (blocked) {
      this.state.blocked.add(key);
      this.state.trusted.delete(key);
    } else {
      this.state.blocked.delete(key);
    }
  }

  pending(): number {
    return this.state.pending.size;
  }

  history(limit = 100): TpaDecision[] {
    return this.decisions.slice(-limit);
  }

  /** Handles an incoming request end to end. Always returns and always logs a decision. */
  async handleRequest(
    player: string,
    playerUuid: string | null,
    requestId?: string,
  ): Promise<TpaDecision> {
    const settings = this.options.getSettings();
    const id = requestId ?? randomUUID();
    openRequest(this.state, { id, player, playerUuid });

    const evaluation = evaluateTpa({ id, player, playerUuid }, settings, this.state);
    const decision: TpaDecision = {
      requestId: id,
      player,
      playerUuid,
      accepted: evaluation.accepted,
      mode: settings.mode,
      reason: evaluation.reason,
      at: new Date().toISOString(),
    };

    recordDecision(this.state, decision);
    this.decisions.push(decision);
    if (this.decisions.length > 500) this.decisions.shift();

    // Logging is mandatory for every decision - persisted and emitted.
    try {
      await this.options.eventsRepository.recordTpaEvent(this.options.botId, decision);
    } catch (error) {
      this.options.logger.error({ err: error }, 'failed to persist tpa decision');
    }
    this.options.events.emit(
      'bot:tpa',
      `TPA from ${player}: ${decision.accepted ? 'accepted' : 'rejected'} (${decision.reason})`,
      {
        ...decision,
      },
      { botId: this.options.botId, severity: decision.accepted ? 'info' : 'warn' },
    );

    try {
      if (decision.accepted) await this.options.onAccepted?.(decision);
      else await this.options.onRejected?.(decision);
    } catch (error) {
      this.options.logger.error({ err: error }, 'tpa side effect failed');
    }
    return decision;
  }

  /** Manual-mode resolution, driven from the API/Discord. */
  async resolveManually(player: string, accept: boolean): Promise<TpaDecision> {
    const settings = this.options.getSettings();
    const id = randomUUID();
    const decision: TpaDecision = {
      requestId: id,
      player,
      playerUuid: null,
      accepted: accept,
      mode: settings.mode,
      reason: accept ? 'accepted manually by operator' : 'rejected manually by operator',
      at: new Date().toISOString(),
    };
    this.decisions.push(decision);
    try {
      await this.options.eventsRepository.recordTpaEvent(this.options.botId, decision);
    } catch (error) {
      this.options.logger.error({ err: error }, 'failed to persist manual tpa decision');
    }
    this.options.events.emit(
      'bot:tpa',
      `TPA from ${player} resolved manually: ${accept ? 'accepted' : 'rejected'}`,
      decision,
      {
        botId: this.options.botId,
      },
    );
    if (accept) await this.options.onAccepted?.(decision);
    else await this.options.onRejected?.(decision);
    return decision;
  }

  private expire(): void {
    const settings = this.options.getSettings();
    const expired = expireRequests(this.state, settings.timeoutMs);
    for (const id of expired) {
      this.options.logger.debug({ id }, 'tpa request expired');
    }
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
