import {
  RateLimiter,
  buildWebhookPayload,
  classifyWebhookEvent,
  isEventAllowed,
  validateWebhookUrl,
  webhookBackoffMs,
  type AgentEvent,
  type Logger,
  type WebhookConfig,
  type WebhookEventKind,
} from '@unionkitbot/shared';
import type { AgentEventEmitter } from '../events.js';
import type { WebhookRepository } from '@unionkitbot/database';

export interface WebhookDispatcherOptions {
  logger: Logger;
  events: AgentEventEmitter;
  repository: WebhookRepository;
  /** Reads the effective config for this bot at dispatch time. */
  getConfig: () => WebhookConfig;
  /** Injectable so tests can exercise retry behaviour without real network calls. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Resolves the row id used for delivery history. */
  getWebhookId?: () => string | null;
}

export interface WebhookDeliveryResult {
  kind: WebhookEventKind;
  status: 'DELIVERED' | 'FAILED' | 'RATE_LIMITED' | 'SKIPPED';
  attempts: number;
  statusCode: number | null;
  error: string | null;
}

/**
 * Delivers agent events to the configured webhook.
 *
 * Disabled unless a URL is configured and `enabled` is set, so an unconfigured deployment
 * makes no outbound requests at all. The URL is treated as a secret: it is never logged and
 * errors carry only the reason, never the URL.
 *
 * Deliveries are serialised through a single chain. Webhooks are notifications, so ordering
 * matters more than throughput, and serialising bounds the outbound sockets a busy bot can
 * open.
 */
export class WebhookDispatcher {
  private readonly options: WebhookDispatcherOptions;
  private readonly limiters = new Map<number, RateLimiter>();
  private chain: Promise<void> = Promise.resolve();

  constructor(options: WebhookDispatcherOptions) {
    this.options = options;
  }

  /** Attaches the dispatcher to the event bus. Returns an unsubscribe function. */
  start(): () => void {
    return this.options.events.on('*', (event) => {
      this.enqueue(event);
    });
  }

  private enqueue(event: AgentEvent): void {
    // Chain every delivery so two events never race and the order is preserved.
    const job = this.chain.then(() => this.handle(event));
    this.chain = job.then(
      () => undefined,
      () => undefined,
    );
  }

  /** Waits for queued deliveries to finish. Used on shutdown and in tests. */
  async drain(timeoutMs = 5_000): Promise<void> {
    await Promise.race([
      this.chain,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  }

  /** Classifies and delivers a single event. Never throws. */
  async handle(event: AgentEvent): Promise<WebhookDeliveryResult | null> {
    const kind = classifyWebhookEvent(event);
    if (!kind) return null;

    const config = this.options.getConfig();
    if (!isEventAllowed(kind, config)) {
      return { kind, status: 'SKIPPED', attempts: 0, statusCode: null, error: null };
    }

    const validation = validateWebhookUrl(config.url);
    if (!validation.ok || !validation.url) {
      this.options.logger.warn(
        { kind, reason: validation.reason },
        'webhook is enabled but its url is unusable',
      );
      return { kind, status: 'SKIPPED', attempts: 0, statusCode: null, error: validation.reason };
    }

    const limiter = this.limiter(config.rateLimitPerMinute);
    if (!limiter.tryAcquire(kind, this.now())) {
      const limited: WebhookDeliveryResult = {
        kind,
        status: 'RATE_LIMITED',
        attempts: 0,
        statusCode: null,
        error: null,
      };
      await this.record(limited);
      return limited;
    }

    const body = JSON.stringify(buildWebhookPayload(kind, event, config.includePayload));
    const maxAttempts = Math.max(1, config.retryCount + 1);
    let lastError: string | null = null;
    let lastStatus: number | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await this.fetchImpl()(validation.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
        lastStatus = response.status;
        if (response.ok) {
          const delivered: WebhookDeliveryResult = {
            kind,
            status: 'DELIVERED',
            attempts: attempt,
            statusCode: response.status,
            error: null,
          };
          await this.record(delivered);
          return delivered;
        }
        lastError = `http ${response.status}`;
        // A 4xx other than 429 is a configuration problem that retrying cannot fix.
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttempts) await this.backoff(attempt);
    }

    const result: WebhookDeliveryResult = {
      kind,
      status: 'FAILED',
      attempts: maxAttempts,
      statusCode: lastStatus,
      error: lastError,
    };
    this.options.logger.warn({ kind, error: lastError }, 'webhook delivery failed');
    await this.record(result);
    return result;
  }

  private backoff(attempt: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, webhookBackoffMs(attempt));
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  private limiter(perMinute: number): RateLimiter {
    const existing = this.limiters.get(perMinute);
    if (existing) return existing;
    const created = new RateLimiter(perMinute);
    this.limiters.set(perMinute, created);
    return created;
  }

  /**
   * Records the attempt in Postgres.
   *
   * A failed history write must not fail the delivery itself, so it is logged at debug level:
   * the webhook has already reached, or not reached, its endpoint.
   */
  private async record(result: WebhookDeliveryResult): Promise<void> {
    const webhookId = this.options.getWebhookId?.() ?? null;
    if (!webhookId) return;
    try {
      await this.options.repository.recordDelivery({
        webhookId,
        kind: result.kind,
        status: result.status,
        attempts: result.attempts,
        statusCode: result.statusCode,
        error: result.error,
      });
    } catch (error) {
      this.options.logger.debug({ err: error }, 'failed to record webhook delivery');
    }
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
