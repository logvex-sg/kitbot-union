import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { DeliveryStatus, Vec3 } from '@unionkitbot/shared';
import { iso, isoOrNull, jsonb, str, type Row } from '../mappers.js';

export interface DeliveryRow {
  id: string;
  taskId: string | null;
  botId: string;
  recipient: string;
  recipientUuid: string | null;
  kitIds: string[];
  status: DeliveryStatus;
  currentStep: string | null;
  destination: Vec3 | null;
  verified: boolean;
  verification: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function mapDelivery(row: Row): DeliveryRow {
  return {
    id: String(row['id']),
    taskId: str(row['task_id']),
    botId: String(row['bot_id']),
    recipient: String(row['recipient']),
    recipientUuid: str(row['recipient_uuid']),
    kitIds: (row['kit_ids'] as string[]) ?? [],
    status: String(row['status']) as DeliveryStatus,
    currentStep: str(row['current_step']),
    destination: (row['destination'] as Vec3) ?? null,
    verified: Boolean(row['verified']),
    verification: (row['verification'] as Record<string, unknown>) ?? null,
    result: (row['result'] as Record<string, unknown>) ?? null,
    error: str(row['error']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    completedAt: isoOrNull(row['completed_at']),
  };
}

export class DeliveryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: {
    botId: string;
    recipient: string;
    kitIds: string[];
    taskId?: string | null;
    destination?: Vec3 | null;
  }): Promise<DeliveryRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO deliveries (id, task_id, bot_id, recipient, kit_ids, status, current_step, destination)
       VALUES ($1,$2,$3,$4,$5,'PENDING','CREATE_TASK',$6) RETURNING *`,
      [
        randomUUID(),
        input.taskId ?? null,
        input.botId,
        input.recipient,
        input.kitIds,
        input.destination ? jsonb(input.destination) : null,
      ],
    );
    return mapDelivery(rows[0]!);
  }

  async update(
    id: string,
    patch: {
      status?: DeliveryStatus;
      currentStep?: string;
      verified?: boolean;
      verification?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: string | null;
      completedAt?: Date;
    },
  ): Promise<DeliveryRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.currentStep !== undefined) push('current_step', patch.currentStep);
    if (patch.verified !== undefined) push('verified', patch.verified);
    if (patch.verification !== undefined) push('verification', jsonb(patch.verification));
    if (patch.result !== undefined) push('result', jsonb(patch.result));
    if (patch.error !== undefined) push('error', patch.error);
    if (patch.completedAt !== undefined) push('completed_at', patch.completedAt);
    if (fields.length === 0) return this.get(id);
    fields.push('updated_at = now()');
    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE deliveries SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return rows[0] ? mapDelivery(rows[0]) : null;
  }

  async get(id: string): Promise<DeliveryRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM deliveries WHERE id = $1', [id]);
    return rows[0] ? mapDelivery(rows[0]) : null;
  }

  async list(
    filter: { botId?: string; status?: string; limit?: number; offset?: number } = {},
  ): Promise<DeliveryRow[]> {
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
    values.push(filter.limit ?? 100, filter.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT * FROM deliveries ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows.map(mapDelivery);
  }
}
