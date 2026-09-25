import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Vec3 } from '@unionkitbot/shared';
import { iso, isoOrNull, num, str, type Row } from '../mappers.js';

export interface BotSessionRow {
  id: string;
  botId: string;
  state: string;
  serverHost: string;
  dimension: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  health: number | null;
  food: number | null;
  reconnectCount: number;
  connectedAt: string | null;
  disconnectedAt: string | null;
  disconnectReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function mapSession(row: Row): BotSessionRow {
  return {
    id: String(row['id']),
    botId: String(row['bot_id']),
    state: String(row['state']),
    serverHost: String(row['server_host']),
    dimension: str(row['dimension']),
    x: num(row['x']),
    y: num(row['y']),
    z: num(row['z']),
    health: num(row['health']),
    food: num(row['food']),
    reconnectCount: Number(row['reconnect_count'] ?? 0),
    connectedAt: isoOrNull(row['connected_at']),
    disconnectedAt: isoOrNull(row['disconnected_at']),
    disconnectReason: str(row['disconnect_reason']),
    metadata: (row['metadata'] as Record<string, unknown>) ?? {},
    createdAt: iso(row['created_at']),
  };
}

export class SessionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: {
    botId: string;
    state: string;
    serverHost: string;
    dimension?: string | null;
    position?: Vec3 | null;
    health?: number | null;
    food?: number | null;
    reconnectCount?: number;
    connectedAt?: Date;
  }): Promise<BotSessionRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO bot_sessions
        (id, bot_id, state, server_host, dimension, x, y, z, health, food, reconnect_count, connected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        randomUUID(),
        input.botId,
        input.state,
        input.serverHost,
        input.dimension ?? null,
        input.position?.x ?? null,
        input.position?.y ?? null,
        input.position?.z ?? null,
        input.health ?? null,
        input.food ?? null,
        input.reconnectCount ?? 0,
        input.connectedAt ?? new Date(),
      ],
    );
    return mapSession(rows[0]!);
  }

  async close(id: string, state: string, reason: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE bot_sessions SET state = $2, disconnected_at = now(), disconnect_reason = $3 WHERE id = $1`,
      [id, state, reason],
    );
  }

  async latestForBot(botId: string): Promise<BotSessionRow | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM bot_sessions WHERE bot_id = $1 ORDER BY created_at DESC LIMIT 1',
      [botId],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async list(limit = 100): Promise<BotSessionRow[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM bot_sessions ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(mapSession);
  }
}
