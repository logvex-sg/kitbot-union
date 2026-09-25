import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { iso, jsonb, str, type Row } from '../mappers.js';

export interface BotInstanceRow {
  id: string;
  name: string;
  username: string;
  minecraftUuid: string | null;
  serverHost: string;
  serverPort: number;
  serverVersion: string | null;
  authType: 'offline' | 'microsoft';
  enabled: boolean;
  autoConnect: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function mapBot(row: Row): BotInstanceRow {
  return {
    id: String(row['id']),
    name: String(row['name']),
    username: String(row['username']),
    minecraftUuid: str(row['minecraft_uuid']),
    serverHost: String(row['server_host']),
    serverPort: Number(row['server_port']),
    serverVersion: str(row['server_version']),
    authType: String(row['auth_type']) as 'offline' | 'microsoft',
    enabled: Boolean(row['enabled']),
    autoConnect: Boolean(row['auto_connect']),
    settings: (row['settings'] as Record<string, unknown>) ?? {},
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

export class BotRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<BotInstanceRow[]> {
    const { rows } = await this.pool.query('SELECT * FROM bot_instances ORDER BY name ASC');
    return rows.map(mapBot);
  }

  async get(id: string): Promise<BotInstanceRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM bot_instances WHERE id = $1', [id]);
    return rows[0] ? mapBot(rows[0]) : null;
  }

  async getByName(name: string): Promise<BotInstanceRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM bot_instances WHERE name = $1', [name]);
    return rows[0] ? mapBot(rows[0]) : null;
  }

  async create(input: {
    name: string;
    username: string;
    serverHost: string;
    serverPort: number;
    serverVersion?: string | null;
    authType: 'offline' | 'microsoft';
    enabled?: boolean;
    autoConnect?: boolean;
    settings?: Record<string, unknown>;
    minecraftUuid?: string | null;
  }): Promise<BotInstanceRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO bot_instances
        (id, name, username, minecraft_uuid, server_host, server_port, server_version,
         auth_type, enabled, auto_connect, settings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        randomUUID(),
        input.name,
        input.username,
        input.minecraftUuid ?? null,
        input.serverHost,
        input.serverPort,
        input.serverVersion ?? null,
        input.authType,
        input.enabled ?? true,
        input.autoConnect ?? true,
        jsonb(input.settings),
      ],
    );
    return mapBot(rows[0]!);
  }

  async update(
    id: string,
    patch: Partial<Omit<BotInstanceRow, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<BotInstanceRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (patch.username !== undefined) push('username', patch.username);
    if (patch.minecraftUuid !== undefined) push('minecraft_uuid', patch.minecraftUuid);
    if (patch.serverHost !== undefined) push('server_host', patch.serverHost);
    if (patch.serverPort !== undefined) push('server_port', patch.serverPort);
    if (patch.serverVersion !== undefined) push('server_version', patch.serverVersion);
    if (patch.authType !== undefined) push('auth_type', patch.authType);
    if (patch.enabled !== undefined) push('enabled', patch.enabled);
    if (patch.autoConnect !== undefined) push('auto_connect', patch.autoConnect);
    if (patch.settings !== undefined) push('settings', jsonb(patch.settings));
    if (fields.length === 0) return this.get(id);
    fields.push('updated_at = now()');
    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE bot_instances SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return rows[0] ? mapBot(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM bot_instances WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
