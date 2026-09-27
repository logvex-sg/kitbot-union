import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { ItemRequirement, OrderRecord, OrderState, OrderStatus } from '@unionkitbot/shared';
import { iso, isoOrNull, jsonb } from '../mappers.js';

export interface OrderRow {
  id: string;
  bot_id: string;
  code: number;
  kit_ids: string[];
  state: OrderState;
  status: OrderStatus;
  recipient_username: string | null;
  recipient_uuid: string | null;
  discord_user_id: string | null;
  requested_by: string;
  source: OrderRecord['source'];
  task_id: string | null;
  delivery_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `
  SELECT id, bot_id, code, kit_ids, state, status, recipient_username, recipient_uuid,
         discord_user_id, requested_by, source, task_id, delivery_id, error,
         created_at, updated_at
  FROM orders`;

export function orderRowToRecord(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    botId: row.bot_id,
    code: row.code,
    kitIds: row.kit_ids ?? [],
    state: row.state,
    status: row.status,
    recipientUsername: row.recipient_username,
    recipientUuid: row.recipient_uuid,
    discordUserId: row.discord_user_id,
    requestedBy: row.requested_by,
    source: row.source,
    taskId: row.task_id,
    deliveryId: row.delivery_id,
    error: row.error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * Orders, their reservation ledger and their delivery attempts.
 *
 * Reservations live in `order_reservations` rather than on the order row so the ledger can
 * be replayed after a restart and so a released reservation keeps its audit history.
 */
export class OrderRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Allocates the next numeric order code for a bot.
   *
   * `MAX(code)+1` inside a transaction is sufficient because codes are scoped per bot and
   * the unique constraint on (bot_id, code) rejects a race rather than silently reusing a
   * number. The caller retries on conflict.
   */
  async nextCode(botId: string): Promise<number> {
    const { rows } = await this.pool.query<{ next: number }>(
      'SELECT COALESCE(MAX(code), 0) + 1 AS next FROM orders WHERE bot_id = $1',
      [botId],
    );
    return Number(rows[0]?.next ?? 1);
  }

  async create(input: {
    botId: string;
    code?: number;
    kitIds: string[];
    recipientUsername?: string | null;
    recipientUuid?: string | null;
    discordUserId?: string | null;
    requestedBy: string;
    source: OrderRecord['source'];
    metadata?: Record<string, unknown>;
  }): Promise<OrderRecord> {
    const code = input.code ?? (await this.nextCode(input.botId));
    const { rows } = await this.pool.query<OrderRow>(
      `INSERT INTO orders
         (id, bot_id, code, kit_ids, state, status, recipient_username, recipient_uuid,
          discord_user_id, requested_by, source, metadata, state_history)
       VALUES ($1,$2,$3,$4,'ORDER_RECEIVED','PENDING',$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, bot_id, code, kit_ids, state, status, recipient_username, recipient_uuid,
                 discord_user_id, requested_by, source, task_id, delivery_id, error,
                 created_at, updated_at`,
      [
        randomUUID(),
        input.botId,
        code,
        input.kitIds,
        input.recipientUsername ?? null,
        input.recipientUuid ?? null,
        input.discordUserId ?? null,
        input.requestedBy,
        input.source,
        jsonb(input.metadata ?? {}),
        jsonb([{ state: 'ORDER_RECEIVED', at: new Date().toISOString() }]),
      ],
    );
    return orderRowToRecord(rows[0]!);
  }

  async get(id: string): Promise<OrderRecord | null> {
    const { rows } = await this.pool.query<OrderRow>(`${SELECT} WHERE id = $1`, [id]);
    return rows[0] ? orderRowToRecord(rows[0]) : null;
  }

  async getByCode(botId: string, code: number): Promise<OrderRecord | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `${SELECT} WHERE bot_id = $1 AND code = $2`,
      [botId, code],
    );
    return rows[0] ? orderRowToRecord(rows[0]) : null;
  }

  async list(
    filter: {
      botId?: string;
      status?: string;
      state?: string;
      discordUserId?: string;
      recipient?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<OrderRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.botId) {
      values.push(filter.botId);
      clauses.push(`bot_id = $${values.length}`);
    }
    if (filter.status) {
      values.push(filter.status);
      clauses.push(`status = $${values.length}`);
    }
    if (filter.state) {
      values.push(filter.state);
      clauses.push(`state = $${values.length}`);
    }
    if (filter.discordUserId) {
      values.push(filter.discordUserId);
      clauses.push(`discord_user_id = $${values.length}`);
    }
    if (filter.recipient) {
      values.push(filter.recipient);
      clauses.push(`lower(recipient_username) = lower($${values.length})`);
    }
    values.push(filter.limit ?? 100, filter.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query<OrderRow>(
      `${SELECT} ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows.map(orderRowToRecord);
  }

  /** Orders that were interrupted mid-flight and must resume after a restart. */
  async resumable(): Promise<OrderRecord[]> {
    const { rows } = await this.pool.query<OrderRow>(
      `${SELECT}
       WHERE status IN ('PENDING','IN_PROGRESS')
       ORDER BY created_at ASC`,
    );
    return rows.map(orderRowToRecord);
  }

  async update(
    id: string,
    patch: {
      state?: OrderState;
      status?: OrderStatus;
      taskId?: string | null;
      deliveryId?: string | null;
      recipientUsername?: string | null;
      recipientUuid?: string | null;
      error?: string | null;
    },
  ): Promise<OrderRecord | null> {
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.state !== undefined) set('state', patch.state);
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.taskId !== undefined) set('task_id', patch.taskId);
    if (patch.deliveryId !== undefined) set('delivery_id', patch.deliveryId);
    if (patch.recipientUsername !== undefined) set('recipient_username', patch.recipientUsername);
    if (patch.recipientUuid !== undefined) set('recipient_uuid', patch.recipientUuid);
    if (patch.error !== undefined) set('error', patch.error);
    values.push(id);
    const { rows } = await this.pool.query<OrderRow>(
      `UPDATE orders SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING id, bot_id, code, kit_ids, state, status, recipient_username, recipient_uuid,
                 discord_user_id, requested_by, source, task_id, delivery_id, error,
                 created_at, updated_at`,
      values,
    );
    return rows[0] ? orderRowToRecord(rows[0]) : null;
  }

  /** Appends a state transition to the order's history for the UI timeline. */
  async appendState(id: string, state: OrderState, detail: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(
      `UPDATE orders
       SET state_history = state_history || $2::jsonb, updated_at = now()
       WHERE id = $1`,
      [id, jsonb([{ state, at: new Date().toISOString(), ...detail }])],
    );
  }

  async stateHistory(id: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query<{ state_history: Array<Record<string, unknown>> }>(
      'SELECT state_history FROM orders WHERE id = $1',
      [id],
    );
    return rows[0]?.state_history ?? [];
  }

  // ------------------------------------------------------------ order items

  async setItems(orderId: string, items: ItemRequirement[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
      for (const item of items) {
        await client.query(
          `INSERT INTO order_items (id, order_id, item, count) VALUES ($1,$2,$3,$4)
           ON CONFLICT (order_id, item) DO UPDATE SET count = EXCLUDED.count`,
          [randomUUID(), orderId, item.item, item.count],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async items(orderId: string): Promise<ItemRequirement[]> {
    const { rows } = await this.pool.query<{ item: string; count: number }>(
      'SELECT item, count FROM order_items WHERE order_id = $1 ORDER BY item',
      [orderId],
    );
    return rows.map((r) => ({ item: r.item, count: Number(r.count) }));
  }

  // ----------------------------------------------------------- reservations

  /**
   * Persists a reservation. Conflicts are ignored because an identical reservation for the
   * same order and item means the same claim is already durable.
   */
  async reserve(orderId: string, botId: string, items: ItemRequirement[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of items) {
        await client.query(
          `INSERT INTO order_reservations (id, order_id, bot_id, item, count, state)
           VALUES ($1,$2,$3,$4,$5,'HELD')
           ON CONFLICT (order_id, item) DO UPDATE
             SET count = EXCLUDED.count, state = 'HELD', released_at = NULL`,
          [randomUUID(), orderId, botId, item.item, item.count],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Marks reservations RELEASED or CONSUMED. Held rows only, so the call is idempotent. */
  async settleReservations(
    orderId: string,
    state: 'RELEASED' | 'CONSUMED',
  ): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE order_reservations
       SET state = $2, released_at = now()
       WHERE order_id = $1 AND state = 'HELD'`,
      [orderId, state],
    );
    return rowCount ?? 0;
  }

  async heldReservations(
    botId: string,
    excludeOrderId?: string,
  ): Promise<Array<{ orderId: string; item: string; count: number }>> {
    const values: unknown[] = [botId];
    let clause = '';
    if (excludeOrderId) {
      values.push(excludeOrderId);
      clause = `AND order_id <> $${values.length}`;
    }
    const { rows } = await this.pool.query<{ order_id: string; item: string; count: number }>(
      `SELECT order_id, item, count FROM order_reservations
       WHERE bot_id = $1 AND state = 'HELD' ${clause}`,
      values,
    );
    return rows.map((r) => ({ orderId: r.order_id, item: r.item, count: Number(r.count) }));
  }

  async reservations(orderId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query(
      `SELECT id, item, count, state, released_at AS "releasedAt", created_at AS "createdAt"
       FROM order_reservations WHERE order_id = $1 ORDER BY item`,
      [orderId],
    );
    return rows as Array<Record<string, unknown>>;
  }

  async listHeldReservations(
    botId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const values: unknown[] = [];
    let where = "WHERE state = 'HELD'";
    if (botId) {
      values.push(botId);
      where += ` AND bot_id = $${values.length}`;
    }
    const { rows } = await this.pool.query(
      `SELECT id, order_id AS "orderId", bot_id AS "botId", item, count, state,
              created_at AS "createdAt"
       FROM order_reservations ${where} ORDER BY created_at`,
      values,
    );
    return rows as Array<Record<string, unknown>>;
  }

  // ------------------------------------------------------ delivery attempts

  async createAttempt(input: {
    orderId?: string | null;
    deliveryId?: string | null;
    botId: string;
    attempt: number;
    recipient: string;
    phase: string;
    tpaCommand?: string | null;
    teleportWaitMs?: number | null;
    dropRange?: number | null;
    items?: ItemRequirement[];
    detail?: Record<string, unknown>;
  }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO delivery_attempts
         (id, order_id, delivery_id, bot_id, attempt, recipient, phase, tpa_command,
          teleport_wait_ms, drop_range, items, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        randomUUID(),
        input.orderId ?? null,
        input.deliveryId ?? null,
        input.botId,
        input.attempt,
        input.recipient,
        input.phase,
        input.tpaCommand ?? null,
        input.teleportWaitMs ?? null,
        input.dropRange ?? null,
        jsonb(input.items ?? []),
        jsonb(input.detail ?? {}),
      ],
    );
    return rows[0]!.id;
  }

  async updateAttempt(
    id: string,
    patch: {
      phase?: string;
      tpaOutcome?: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'TIMEOUT';
      verified?: boolean;
      error?: string | null;
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.phase !== undefined) set('phase', patch.phase);
    if (patch.tpaOutcome !== undefined) set('tpa_outcome', patch.tpaOutcome);
    if (patch.verified !== undefined) set('verified', patch.verified);
    if (patch.error !== undefined) set('error', patch.error);
    if (patch.detail !== undefined) set('detail', jsonb(patch.detail));
    values.push(id);
    await this.pool.query(
      `UPDATE delivery_attempts SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values,
    );
  }

  async listAttempts(
    filter: {
      botId?: string;
      orderId?: string;
      deliveryId?: string;
      recipient?: string;
      outcome?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      clauses.push(`${column} = $${values.length}`);
    };
    if (filter.botId) add('bot_id', filter.botId);
    if (filter.orderId) add('order_id', filter.orderId);
    if (filter.deliveryId) add('delivery_id', filter.deliveryId);
    if (filter.recipient) {
      values.push(filter.recipient);
      clauses.push(`lower(recipient) = lower($${values.length})`);
    }
    if (filter.outcome) add('tpa_outcome', filter.outcome);
    values.push(filter.limit ?? 100, filter.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT id, order_id AS "orderId", delivery_id AS "deliveryId", bot_id AS "botId",
              attempt, recipient, phase, tpa_command AS "tpaCommand",
              tpa_outcome AS "tpaOutcome", teleport_wait_ms AS "teleportWaitMs",
              drop_range AS "dropRange", items, verified, detail, error,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM delivery_attempts ${where} ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows as Array<Record<string, unknown>>;
  }

  // ---------------------------------------------------- navigation failures

  async recordNavigationFailure(input: {
    botId: string;
    taskId?: string | null;
    label: string;
    reason: string;
    replans: number;
    elapsedMs: number;
    dimension?: string | null;
    from?: { x: number; y: number; z: number } | null;
    to?: { x: number; y: number; z: number } | null;
    stuck?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO navigation_failures
         (id, bot_id, task_id, label, reason, replans, elapsed_ms, dimension,
          from_x, from_y, from_z, to_x, to_y, to_z, stuck, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        randomUUID(),
        input.botId,
        input.taskId ?? null,
        input.label,
        input.reason,
        input.replans,
        input.elapsedMs,
        input.dimension ?? null,
        input.from?.x ?? null,
        input.from?.y ?? null,
        input.from?.z ?? null,
        input.to?.x ?? null,
        input.to?.y ?? null,
        input.to?.z ?? null,
        input.stuck ?? false,
        jsonb(input.metadata ?? {}),
      ],
    );
    return rows[0]!.id;
  }

  async listNavigationFailures(
    filter: { botId?: string; stuckOnly?: boolean; limit?: number; offset?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.botId) {
      values.push(filter.botId);
      clauses.push(`bot_id = $${values.length}`);
    }
    if (filter.stuckOnly) clauses.push('stuck = TRUE');
    values.push(filter.limit ?? 100, filter.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT id, bot_id AS "botId", task_id AS "taskId", label, reason, replans,
              elapsed_ms AS "elapsedMs", dimension, from_x AS "fromX", from_y AS "fromY",
              from_z AS "fromZ", to_x AS "toX", to_y AS "toY", to_z AS "toZ", stuck,
              metadata, created_at AS "createdAt"
       FROM navigation_failures ${where} ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows as Array<Record<string, unknown>>;
  }

  /** Aggregated failure counts, for the UI's navigation panel. */
  async navigationFailureSummary(botId?: string): Promise<Array<Record<string, unknown>>> {
    const values: unknown[] = [];
    let where = '';
    if (botId) {
      values.push(botId);
      where = `WHERE bot_id = $${values.length}`;
    }
    const { rows } = await this.pool.query(
      `SELECT reason, COUNT(*)::int AS count, SUM(CASE WHEN stuck THEN 1 ELSE 0 END)::int AS stuck
       FROM navigation_failures ${where}
       GROUP BY reason ORDER BY count DESC LIMIT 20`,
      values,
    );
    return rows as Array<Record<string, unknown>>;
  }

  /** Deletes terminal orders older than the retention window. */
  async pruneTerminal(olderThanDays = 30): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM orders
       WHERE status IN ('COMPLETED','FAILED','CANCELLED')
         AND updated_at < now() - ($1::int * interval '1 day')`,
      [olderThanDays],
    );
    return rowCount ?? 0;
  }
}

export { iso, isoOrNull };
