import type { AgentEventType } from './events.js';
import type { AgentEvent } from './events.js';

/**
 * Optional outbound webhook notifications.
 *
 * Disabled unless explicitly configured. The URL is treated as a secret (it usually embeds
 * a token), so it is redacted from logs and never echoed into API responses.
 */

export const WEBHOOK_EVENT_KINDS = [
  'bot_death',
  'delivery_completed',
  'delivery_failed',
  'bot_disconnected',
  'bot_recovered',
  'critical_error',
] as const;
export type WebhookEventKind = (typeof WEBHOOK_EVENT_KINDS)[number];

/**
 * Keeps only recognised kinds, so a typo in `WEBHOOK_EVENTS` silently cannot widen the
 * allow-list into "everything" and cannot persist an unusable value.
 */
export function parseWebhookEventKinds(values: readonly string[]): WebhookEventKind[] {
  const seen = new Set<WebhookEventKind>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase() as WebhookEventKind;
    if ((WEBHOOK_EVENT_KINDS as readonly string[]).includes(normalized)) seen.add(normalized);
  }
  return [...seen];
}

/**
 * Host portion of a URL, for diagnostics.
 *
 * A webhook URL usually embeds a secret token in its path, so only the host may ever be
 * surfaced in logs or Discord replies.
 */
export function safeHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    // Unparseable: report nothing rather than risk echoing the token.
    return null;
  }
}

/** Agent event types that map onto each webhook kind. */
export const WEBHOOK_EVENT_SOURCES: Record<WebhookEventKind, AgentEventType> = {
  bot_death: 'bot:death',
  delivery_completed: 'bot:delivery',
  delivery_failed: 'bot:delivery',
  bot_disconnected: 'bot:disconnected',
  bot_recovered: 'bot:connected',
  critical_error: 'bot:error',
};

export interface WebhookConfig {
  enabled: boolean;
  url: string | null;
  /** Empty means all kinds are delivered. */
  events: WebhookEventKind[];
  retryCount: number;
  timeoutMs: number;
  /** Maximum deliveries per window per webhook. */
  rateLimitPerMinute: number;
  /** Include the raw event payload in the body. */
  includePayload: boolean;
}

export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = {
  enabled: false,
  url: null,
  events: [],
  retryCount: 2,
  timeoutMs: 5_000,
  rateLimitPerMinute: 30,
  includePayload: false,
};

/** Only http/https, and never something that resolves into the container network. */
export function validateWebhookUrl(raw: unknown): { ok: boolean; reason: string; url: string | null } {
  const value = String(raw ?? '').trim();
  if (value.length === 0) return { ok: false, reason: 'webhook url is required', url: null };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'webhook url is not a valid URL', url: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'webhook url must use http or https', url: null };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'webhook url must not embed credentials', url: null };
  }
  return { ok: true, reason: 'ok', url: parsed.toString() };
}

/**
 * Maps an agent event onto a webhook kind.
 *
 * Delivery events carry their status in the payload, so completion and failure are the
 * same agent event type and are separated here. Returns null for events that are not
 * webhook-worthy.
 */
export function classifyWebhookEvent(event: AgentEvent): WebhookEventKind | null {
  if (event.type === 'bot:death') return 'bot_death';
  if (event.type === 'bot:disconnected') return 'bot_disconnected';
  if (event.type === 'bot:connected') return 'bot_recovered';
  if (event.type === 'bot:delivery') {
    const status = (event.data as { status?: string } | undefined)?.status;
    if (status === 'COMPLETED') return 'delivery_completed';
    if (status === 'FAILED') return 'delivery_failed';
    return null;
  }
  // Any error-level event is a critical error; warnings are not webhooked.
  if (event.type === 'bot:error' || event.severity === 'critical') return 'critical_error';
  return null;
}

/** True when the event kind is permitted by the allow-list (empty list = all). */
export function isEventAllowed(kind: WebhookEventKind, config: WebhookConfig): boolean {
  if (!config.enabled) return false;
  if (!config.url) return false;
  if (config.events.length === 0) return true;
  return config.events.includes(kind);
}

/** Redacts a webhook URL so it is safe to log or return over the API. */
export function redactWebhookUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last.length > 6) {
      segments[segments.length - 1] = `${last.slice(0, 4)}...${last.slice(-2)}`;
    }
    parsed.pathname = `/${segments.join('/')}`;
    if (parsed.search) parsed.search = '?redacted';
    return parsed.toString();
  } catch {
    return '<invalid>';
  }
}

/**
 * Sliding-window rate limiter, one window per key.
 *
 * A single global window would let a noisy bot starve a quiet one, so the key is the
 * event kind and the window is per webhook.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Returns true when the call is permitted, and records it. */
  tryAcquire(key: string, now = Date.now()): boolean {
    if (this.limit <= 0) return false;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (timestamps.length >= this.limit) {
      this.hits.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return true;
  }

  /** Number of calls in the current window, for status reporting. */
  count(key: string, now = Date.now()): number {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length;
  }

  reset(): void {
    this.hits.clear();
  }
}

/** Exponential backoff with jitter for webhook retries. */
export function webhookBackoffMs(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}

export interface WebhookPayload {
  kind: WebhookEventKind;
  botId: string | null;
  at: string;
  message: string;
  severity: AgentEvent['severity'];
  data?: unknown;
}

/**
 * Builds the JSON body. The payload is omitted unless explicitly enabled, so a webhook
 * endpoint does not receive inventories, coordinates or chat by default.
 */
export function buildWebhookPayload(
  kind: WebhookEventKind,
  event: AgentEvent,
  includePayload: boolean,
): WebhookPayload {
  const payload: WebhookPayload = {
    kind,
    botId: event.botId,
    at: event.at,
    message: event.message,
    severity: event.severity,
  };
  if (includePayload) payload.data = event.data;
  return payload;
}
