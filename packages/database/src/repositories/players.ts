import type pg from 'pg';
import { randomUUID } from 'node:crypto';

export class PlayerRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(input: {
    username: string;
    minecraftUuid?: string | null;
    discordId?: string | null;
  }): Promise<string> {
    const { rows } = await this.pool.query(
      `INSERT INTO players (id, username, minecraft_uuid, discord_id, last_seen_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (username) DO UPDATE SET
         last_seen_at = now(),
         minecraft_uuid = COALESCE(EXCLUDED.minecraft_uuid, players.minecraft_uuid),
         discord_id = COALESCE(EXCLUDED.discord_id, players.discord_id)
       RETURNING id`,
      [randomUUID(), input.username, input.minecraftUuid ?? null, input.discordId ?? null],
    );
    return String(rows[0]!['id']);
  }

  async getByUsername(username: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query('SELECT * FROM players WHERE username = $1', [username]);
    return (rows[0] as Record<string, unknown>) ?? null;
  }

  async list(limit = 200): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query(
      'SELECT * FROM players ORDER BY last_seen_at DESC LIMIT $1',
      [limit],
    );
    return rows as Array<Record<string, unknown>>;
  }

  async setPermission(playerId: string, permission: string, grantedBy: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO player_permissions (id, player_id, permission, granted_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (player_id, permission) DO NOTHING`,
      [randomUUID(), playerId, permission, grantedBy],
    );
  }

  async listPermissions(playerId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ permission: string }>(
      'SELECT permission FROM player_permissions WHERE player_id = $1',
      [playerId],
    );
    return rows.map((r) => r.permission);
  }
}
