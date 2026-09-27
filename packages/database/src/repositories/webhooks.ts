import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { WebhookConfig, WebhookEventKind } from '@unionkitbot/shared';
import { DEFAULT_WEBHOOK_CONFIG, redactWebhookUrl } from '@unionkitbot/shared';

export interface WebhookConfigRecord extends WebhookConfig {
  id: string;
  name: string;
  /** Redacted form for API responses and logs. */
  redactedUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: Record<string, unknown>): WebhookConfigRecord {
  const url = (row['url'] as string | null) ?? null;
  return {
    id: String(row['id']),
    name: String(row['name']),
    enabled: Boolean(row['enabled']),
    url,
    redactedUrl: redactWebhookUrl(url),
    events: ((row['events'] as string[] | null) ?? []) as WebhookEventKind[],
    retryCount: Number(row['retry_count']),
    timeoutMs: Number(row['timeout_ms']),
    rateLimitPerMinute: Number(row['rate_limit_per_minute']),
    includePayload: Boolean(row['include_payload']),
    createdAt: new Date(String(row['created_at'])).toISOString(),
    updatedAt: new Date(String(row['updated_at'])).toISOString(),
  };
}

const SELECT = `
  SELECT id, name, enabled, url, events, retry_count, timeout_ms, rate_limit_per_minute,
         include_payload, created_at, updated_at
  FROM webhook_config`;

/**
 * Webhook configuration and delivery history.
 *
 * The stored URL is a secret (it usually embeds a token), so every value returned to a
 * caller carries a redacted copy and the raw URL is only read by the dispatcher itself.
 */
export class WebhookRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<WebhookConfigRecord[]> {
    const { rows } = await this.pool.query(`${SELECT} ORDER BY name`);
    return rows.map((r) => toRecord(r as Record<string, unknown>));
  }

  async get(id: string): Promise<WebhookConfigRecord | null> {
    const { rows } = await this.pool.query(`${SELECT} WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0] as Record<string, unknown>) : null;
  }

  async getByName(name: string): Promise<WebhookConfigRecord | null> {
    const { rows } = await this.pool.query(`${SELECT} WHERE name = $1`, [name]);
    return rows[0] ? toRecord(rows[0] as Record<string, unknown>) : null;
  }

  /** Enabled webhooks that have a URL, which is what the dispatcher reads. */
  async enabled(): Promise<WebhookConfigRecord[]> {
    const { rows } = await this.pool.query(
      `${SELECT} WHERE enabled = TRUE AND url IS NOT NULL ORDER BY name`,
    );
    return rows.map((r) => toRecord(r as Record<string, unknown>));
  }

  async upsert(input: {
    name?: string;
    enabled?: boolean;
    url?: string | null;
    events?: string[];
    retryCount?: number;
    timeoutMs?: number;
    rateLimitPerMinute?: number;
    includePayload?: boolean;
  }): Promise<WebhookConfigRecord> {
    const name = input.name ?? 'default';
    const url = input.url ?? null;
    const { rows } = await this.pool.query(
      `INSERT INTO webhook_config
         (id, name, enabled, url, events, retry_count, timeout_ms, rate_limit_per_minute,
          include_payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), now())
       ON CONFLICT (name) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         url = EXCLUDED.url,
         events = EXCLUDED.events,
         retry_count = EXCLUDED.retry_count,
         timeout_ms = EXCLUDED.timeout_ms,
         rate_limit_per_minute = EXCLUDED.rate_limit_per_minute,
         include_payload = EXCLUDED.include_payload,
         updated_at = now()
       RETURNING id, name, enabled, url, events, retry_count, timeout_ms, rate_limit_per_minute,
                 include_payload, created_at, updated_at`,
      [
        randomUUID(),
        name,
        input.enabled ?? DEFAULT_WEBHOOK_CONFIG.enabled,
        url,
        input.events ?? [],
        input.retryCount ?? DEFAULT_WEBHOOK_CONFIG.retryCount,
        input.timeoutMs ?? DEFAULT_WEBHOOK_CONFIG.timeoutMs,
        input.rateLimitPerMinute ?? DEFAULT_WEBHOOK_CONFIG.rateLimitPerMinute,
        input.includePayload ?? DEFAULT_WEBHOOK_CONFIG.includePayload,
      ],
    );
    return toRecord(rows[0] as Record<string, unknown>);
  }

  /** Partial update that leaves unmentioned columns untouched. */
  async update(
    id: string,
    patch: {
      enabled?: boolean;
      url?: string | null;
      events?: string[];
      retryCount?: number;
      timeoutMs?: number;
      rateLimitPerMinute?: number;
      includePayload?: boolean;
    },
  ): Promise<WebhookConfigRecord | null> {
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.enabled !== undefined) set('enabled', patch.enabled);
    if (patch.url !== undefined) set('url', patch.url);
    if (patch.events !== undefined) set('events', patch.events);
    if (patch.retryCount !== undefined) set('retry_count', patch.retryCount);
    if (patch.timeoutMs !== undefined) set('timeout_ms', patch.timeoutMs);
    if (patch.rateLimitPerMinute !== undefined)
      set('rate_limit_per_minute', patch.rateLimitPerMinute);
    if (patch.includePayload !== undefined) set('include_payload', patch.includePayload);
    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE webhook_config SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING id, name, enabled, url, events, retry_count, timeout_ms, rate_limit_per_minute,
                 include_payload, created_at, updated_at`,
      values,
    );
    return rows[0] ? toRecord(rows[0] as Record<string, unknown>) : null;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM webhook_config WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async recordDelivery(input: {
    webhookId: string;
    kind: WebhookEventKind;
    status: 'DELIVERED' | 'FAILED' | 'RATE_LIMITED' | 'SKIPPED';
    attempts: number;
    statusCode?: number | null;
    error?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, kind, status, attempts, status_code, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        input.webhookId,
        input.kind,
        input.status,
        input.attempts,
        input.statusCode ?? null,
        input.error ?? null,
      ],
    );
  }

  async listDeliveries(
    filter: { webhookId?: string; kind?: string; limit?: number; offset?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.webhookId) {
      values.push(filter.webhookId);
      clauses.push(`d.webhook_id = $${values.length}`);
    }
    if (filter.kind) {
      values.push(filter.kind);
      clauses.push(`d.kind = $${values.length}`);
    }
    values.push(filter.limit ?? 100, filter.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT d.id, d.webhook_id AS "webhookId", w.name AS "webhookName", d.kind, d.status,
              d.attempts, d.status_code AS "statusCode", d.error, d.created_at AS "createdAt"
       FROM webhook_deliveries d
       LEFT JOIN webhook_config w ON w.id = d.webhook_id
       ${where} ORDER BY d.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows as Array<Record<string, unknown>>;
  }

  /** Delivery counts per kind and status, for the webhook panel. */
  async deliverySummary(): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query(
      `SELECT kind, status, COUNT(*)::int AS count
       FROM webhook_deliveries
       WHERE created_at > now() - interval '7 days'
       GROUP BY kind, status ORDER BY kind, status`,
    );
    return rows as Array<Record<string, unknown>>;
  }

  async pruneDeliveries(olderThanDays = 14): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM webhook_deliveries
       WHERE created_at < now() - ($1::int * interval '1 day')`,
      [olderThanDays],
    );
    return rowCount ?? 0;
  }
}
