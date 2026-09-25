import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { WaypointType } from '@unionkitbot/shared';
import { iso, jsonb, type Row } from '../mappers.js';

export interface WaypointRow {
  id: string;
  name: string;
  type: WaypointType;
  server: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  botId: string | null;
  playerId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function mapWaypoint(row: Row): WaypointRow {
  return {
    id: String(row['id']),
    name: String(row['name']),
    type: String(row['type']) as WaypointType,
    server: String(row['server']),
    dimension: String(row['dimension']),
    x: Number(row['x']),
    y: Number(row['y']),
    z: Number(row['z']),
    botId: row['bot_id'] ? String(row['bot_id']) : null,
    playerId: row['player_id'] ? String(row['player_id']) : null,
    metadata: (row['metadata'] as Record<string, unknown>) ?? {},
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

export class WaypointRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: {
    name: string;
    type: WaypointType;
    server: string;
    dimension: string;
    x: number;
    y: number;
    z: number;
    botId?: string | null;
    playerId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<WaypointRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO waypoints (id, name, type, server, dimension, x, y, z, bot_id, player_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        randomUUID(),
        input.name,
        input.type,
        input.server,
        input.dimension,
        input.x,
        input.y,
        input.z,
        input.botId ?? null,
        input.playerId ?? null,
        jsonb(input.metadata),
      ],
    );
    return mapWaypoint(rows[0]!);
  }

  async list(
    filter: {
      type?: string;
      server?: string;
      botId?: string;
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<WaypointRow[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.type) {
      values.push(filter.type);
      clauses.push(`type = $${values.length}`);
    }
    if (filter.server) {
      values.push(filter.server);
      clauses.push(`server = $${values.length}`);
    }
    if (filter.botId) {
      values.push(filter.botId);
      clauses.push(`bot_id = $${values.length}`);
    }
    if (filter.search) {
      values.push(`%${filter.search.toLowerCase()}%`);
      clauses.push(`lower(name) LIKE $${values.length}`);
    }
    values.push(filter.limit ?? 200, filter.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT * FROM waypoints ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows.map(mapWaypoint);
  }

  async get(id: string): Promise<WaypointRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM waypoints WHERE id = $1', [id]);
    return rows[0] ? mapWaypoint(rows[0]) : null;
  }

  async update(
    id: string,
    patch: Partial<Omit<WaypointRow, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<WaypointRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.type !== undefined) push('type', patch.type);
    if (patch.server !== undefined) push('server', patch.server);
    if (patch.dimension !== undefined) push('dimension', patch.dimension);
    if (patch.x !== undefined) push('x', patch.x);
    if (patch.y !== undefined) push('y', patch.y);
    if (patch.z !== undefined) push('z', patch.z);
    if (patch.metadata !== undefined) push('metadata', jsonb(patch.metadata));
    if (fields.length === 0) return this.get(id);
    fields.push('updated_at = now()');
    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE waypoints SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return rows[0] ? mapWaypoint(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM waypoints WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
