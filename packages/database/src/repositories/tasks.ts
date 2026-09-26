import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { PriorityTask, TaskPriority, TaskStatus, TaskType } from '@unionkitbot/shared';
import { iso, isoOrNull, jsonb, str, type Row } from '../mappers.js';

export interface TaskRow {
  id: string;
  botId: string | null;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  payload: Record<string, unknown>;
  resumeState: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function mapTask(row: Row): TaskRow {
  return {
    id: String(row['id']),
    botId: str(row['bot_id']),
    type: String(row['type']) as TaskType,
    priority: String(row['priority']) as TaskPriority,
    status: String(row['status']) as TaskStatus,
    payload: (row['payload'] as Record<string, unknown>) ?? {},
    resumeState: (row['resume_state'] as Record<string, unknown>) ?? {},
    attempts: Number(row['attempts'] ?? 0),
    maxAttempts: Number(row['max_attempts'] ?? 3),
    result: row['result'] ?? null,
    error: str(row['error']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    startedAt: isoOrNull(row['started_at']),
    finishedAt: isoOrNull(row['finished_at']),
  };
}

export function taskRowToPriorityTask(row: TaskRow): PriorityTask {
  return {
    id: row.id,
    botId: row.botId ?? '',
    type: row.type,
    priority: row.priority,
    status: row.status,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    createdAt: Date.parse(row.createdAt),
    updatedAt: Date.parse(row.updatedAt),
    startedAt: row.startedAt ? Date.parse(row.startedAt) : null,
    finishedAt: row.finishedAt ? Date.parse(row.finishedAt) : null,
    error: row.error,
    result: row.result,
    resumeState: row.resumeState,
  };
}

export class TaskRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(task: PriorityTask): Promise<TaskRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO tasks
        (id, bot_id, type, priority, status, payload, resume_state, attempts, max_attempts,
         result, error, created_at, updated_at, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status, priority = EXCLUDED.priority, payload = EXCLUDED.payload,
         resume_state = EXCLUDED.resume_state, attempts = EXCLUDED.attempts,
         max_attempts = EXCLUDED.max_attempts, result = EXCLUDED.result, error = EXCLUDED.error,
         updated_at = EXCLUDED.updated_at, started_at = EXCLUDED.started_at,
         finished_at = EXCLUDED.finished_at
       RETURNING *`,
      [
        task.id,
        task.botId || null,
        task.type,
        task.priority,
        task.status,
        jsonb(task.payload),
        jsonb(task.resumeState),
        task.attempts,
        task.maxAttempts,
        task.result === null || task.result === undefined ? null : jsonb(task.result),
        task.error,
        new Date(task.createdAt),
        new Date(task.updatedAt),
        task.startedAt ? new Date(task.startedAt) : null,
        task.finishedAt ? new Date(task.finishedAt) : null,
      ],
    );
    return mapTask(rows[0]!);
  }

  async list(
    filter: {
      botId?: string;
      status?: string;
      type?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<TaskRow[]> {
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
    if (filter.type) {
      values.push(filter.type);
      clauses.push(`type = $${values.length}`);
    }
    values.push(filter.limit ?? 100, filter.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows.map(mapTask);
  }

  async get(id: string): Promise<TaskRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  /** Tasks still in flight, used to restore the queue after a process restart. */
  async resumable(): Promise<TaskRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM tasks WHERE status IN ('PENDING','RUNNING','PAUSED') ORDER BY created_at ASC`,
    );
    return rows.map(mapTask);
  }

  async recordEvent(
    taskId: string,
    event: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO task_events (id, task_id, event, detail) VALUES ($1,$2,$3,$4)',
      [randomUUID(), taskId, event, jsonb(detail)],
    );
  }

  async listEvents(
    taskId: string,
    limit = 100,
  ): Promise<
    Array<{ id: string; event: string; detail: Record<string, unknown>; createdAt: string }>
  > {
    const { rows } = await this.pool.query(
      'SELECT * FROM task_events WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2',
      [taskId, limit],
    );
    return rows.map((r) => ({
      id: String(r['id']),
      event: String(r['event']),
      detail: (r['detail'] as Record<string, unknown>) ?? {},
      createdAt: iso(r['created_at']),
    }));
  }
}
