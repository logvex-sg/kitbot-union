import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { TpaDecision } from '@unionkitbot/shared';
import { jsonb } from '../mappers.js';

function listQuery(
  table: string,
  clauses: string[],
  values: unknown[],
  limit: number,
  offset: number,
  alias = '',
): string {
  values.push(limit, offset);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return `SELECT ${alias}* FROM ${table} ${alias}${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`;
}

export class EventRepository {
  constructor(private readonly pool: pg.Pool) {}

  async recordSystemEvent(input: {
    type: string;
    severity: string;
    botId?: string | null;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO system_events (id, type, severity, bot_id, message, data) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        randomUUID(),
        input.type,
        input.severity,
        input.botId ?? null,
        input.message,
        jsonb(input.data),
      ],
    );
  }

  async listSystemEvents(
    filter: { botId?: string; severity?: string; limit?: number; offset?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.botId) {
      values.push(filter.botId);
      clauses.push(`bot_id = $${values.length}`);
    }
    if (filter.severity) {
      values.push(filter.severity);
      clauses.push(`severity = $${values.length}`);
    }
    const sql = listQuery(
      'system_events',
      clauses,
      values,
      filter.limit ?? 200,
      filter.offset ?? 0,
    );
    const { rows } = await this.pool.query(sql, values);
    return rows as Array<Record<string, unknown>>;
  }

  async recordChatEvent(input: {
    botId: string;
    raw: string;
    eventType: string;
    player: string | null;
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO chat_events (id, bot_id, raw, event_type, player, message, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        input.botId,
        input.raw,
        input.eventType,
        input.player,
        input.message,
        jsonb(input.metadata),
      ],
    );
    return id;
  }

  async listChatEvents(
    filter: { botId?: string; eventType?: string; limit?: number; offset?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.botId) {
      values.push(filter.botId);
      clauses.push(`bot_id = $${values.length}`);
    }
    if (filter.eventType) {
      values.push(filter.eventType);
      clauses.push(`event_type = $${values.length}`);
    }
    const sql = listQuery('chat_events', clauses, values, filter.limit ?? 200, filter.offset ?? 0);
    const { rows } = await this.pool.query(sql, values);
    return rows as Array<Record<string, unknown>>;
  }

  async recordTpaEvent(botId: string, decision: TpaDecision): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO tpa_events (id, bot_id, request_id, player, player_uuid, mode, accepted, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        botId,
        decision.requestId,
        decision.player,
        decision.playerUuid,
        decision.mode,
        decision.accepted,
        decision.reason,
      ],
    );
    return id;
  }

  async listTpaEvents(
    filter: { botId?: string; limit?: number; offset?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.botId) {
      values.push(filter.botId);
      clauses.push(`bot_id = $${values.length}`);
    }
    const sql = listQuery('tpa_events', clauses, values, filter.limit ?? 200, filter.offset ?? 0);
    const { rows } = await this.pool.query(sql, values);
    return rows as Array<Record<string, unknown>>;
  }

  async recordDeath(input: {
    botId: string;
    dimension: string | null;
    x: number | null;
    y: number | null;
    z: number | null;
    cause: string | null;
    activeTaskId?: string | null;
    waypointId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO death_events (id, bot_id, dimension, x, y, z, cause, active_task_id, waypoint_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        input.botId,
        input.dimension,
        input.x,
        input.y,
        input.z,
        input.cause,
        input.activeTaskId ?? null,
        input.waypointId ?? null,
        jsonb(input.metadata),
      ],
    );
    return id;
  }

  async markDeathRecovered(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE death_events SET recovered = TRUE, recovered_at = now() WHERE id = $1',
      [id],
    );
  }

  async listDeaths(
    filter: { botId?: string; limit?: number; offset?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.botId) {
      values.push(filter.botId);
      clauses.push(`bot_id = $${values.length}`);
    }
    const sql = listQuery('death_events', clauses, values, filter.limit ?? 100, filter.offset ?? 0);
    const { rows } = await this.pool.query(sql, values);
    return rows as Array<Record<string, unknown>>;
  }

  async audit(entry: {
    actor: string;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (id, actor, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        randomUUID(),
        entry.actor,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        jsonb(entry.detail),
      ],
    );
  }

  async listAudit(
    filter: { limit?: number; offset?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query(
      'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [filter.limit ?? 200, filter.offset ?? 0],
    );
    return rows as Array<Record<string, unknown>>;
  }
}
