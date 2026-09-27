import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { AccountLink, LinkPolicy } from '@unionkitbot/shared';
import { DEFAULT_LINK_POLICY, decideLink } from '@unionkitbot/shared';

function toLink(row: Record<string, unknown>): AccountLink {
  return {
    id: String(row['id']),
    discordUserId: String(row['discord_user_id']),
    minecraftUsername: String(row['minecraft_username']),
    minecraftUuid: (row['minecraft_uuid'] as string | null) ?? null,
    verified: Boolean(row['verified']),
    method: row['method'] as AccountLink['method'],
    createdAt: new Date(String(row['created_at'])).toISOString(),
    updatedAt: new Date(String(row['updated_at'])).toISOString(),
  };
}

export type LinkResult =
  | { ok: true; link: AccountLink; action: 'created' | 'replaced' | 'reaffirmed'; reason: string }
  | { ok: false; reason: string; code: 'invalid' | 'conflict' | 'not_found' };

/**
 * Discord <-> Minecraft account links.
 *
 * No password, token or Microsoft credential is stored: a link only records which
 * Minecraft account a Discord user claims. The database enforces that one Minecraft
 * username belongs to at most one Discord user.
 */
export class AccountLinkRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listAll(limit = 500): Promise<AccountLink[]> {
    const { rows } = await this.pool.query(
      `SELECT id, discord_user_id, minecraft_username, minecraft_uuid, verified, method,
              created_at, updated_at
       FROM account_links ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => toLink(r as Record<string, unknown>));
  }

  async list(
    filter: {
      discordUserId?: string;
      minecraftUsername?: string;
      verified?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<AccountLink[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.discordUserId) {
      values.push(filter.discordUserId);
      clauses.push(`discord_user_id = $${values.length}`);
    }
    if (filter.minecraftUsername) {
      values.push(filter.minecraftUsername);
      clauses.push(`lower(minecraft_username) = lower($${values.length})`);
    }
    if (filter.verified !== undefined) {
      values.push(filter.verified);
      clauses.push(`verified = $${values.length}`);
    }
    values.push(filter.limit ?? 200, filter.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT id, discord_user_id, minecraft_username, minecraft_uuid, verified, method,
              created_at, updated_at
       FROM account_links ${where} ORDER BY updated_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows.map((r) => toLink(r as Record<string, unknown>));
  }

  async forDiscordUser(discordUserId: string): Promise<AccountLink[]> {
    return this.list({ discordUserId, limit: 50 });
  }

  async get(id: string): Promise<AccountLink | null> {
    const { rows } = await this.pool.query(
      `SELECT id, discord_user_id, minecraft_username, minecraft_uuid, verified, method,
              created_at, updated_at
       FROM account_links WHERE id = $1`,
      [id],
    );
    return rows[0] ? toLink(rows[0] as Record<string, unknown>) : null;
  }

  async findByUsername(username: string): Promise<AccountLink | null> {
    const { rows } = await this.pool.query(
      `SELECT id, discord_user_id, minecraft_username, minecraft_uuid, verified, method,
              created_at, updated_at
       FROM account_links WHERE lower(minecraft_username) = lower($1)`,
      [username],
    );
    return rows[0] ? toLink(rows[0] as Record<string, unknown>) : null;
  }

  /**
   * Creates or replaces a link after running the configured policy.
   *
   * The policy decision is made by the shared `decideLink` helper so the Discord command,
   * the REST route and any importer enforce identical rules.
   */
  async link(input: {
    discordUserId: string;
    minecraftUsername: string;
    minecraftUuid?: string | null;
    method?: AccountLink['method'];
    linkedBy?: string | null;
    policy?: LinkPolicy;
    /** Operator action: force the link to be usable immediately. */
    forceVerified?: boolean;
  }): Promise<LinkResult> {
    const policy = input.policy ?? DEFAULT_LINK_POLICY;
    const existing = await this.listAll(5000);
    const decision = decideLink({
      discordUserId: input.discordUserId,
      minecraftUsername: input.minecraftUsername,
      existing,
      policy,
    });

    if (decision.action === 'reject') {
      const code = decision.reason.includes('already linked') ? 'conflict' : 'invalid';
      return { ok: false, reason: decision.reason, code };
    }

    const verified = input.forceVerified ?? decision.verified;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (decision.action === 'replace') {
        await client.query('DELETE FROM account_links WHERE id = $1', [decision.replaceLinkId]);
      }
      // A concurrent creation of the same username is rejected by the unique index; the
      // ON CONFLICT target keeps a re-affirmation of the same discord user idempotent.
      const { rows } = await client.query(
        `INSERT INTO account_links
           (id, discord_user_id, minecraft_username, minecraft_uuid, verified, method, linked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (discord_user_id) DO UPDATE SET
           minecraft_username = EXCLUDED.minecraft_username,
           minecraft_uuid = COALESCE(EXCLUDED.minecraft_uuid, account_links.minecraft_uuid),
           verified = EXCLUDED.verified,
           method = EXCLUDED.method,
           linked_by = EXCLUDED.linked_by,
           updated_at = now()
         RETURNING id, discord_user_id, minecraft_username, minecraft_uuid, verified, method,
                   created_at, updated_at`,
        [
          randomUUID(),
          input.discordUserId,
          input.minecraftUsername,
          input.minecraftUuid ?? null,
          verified,
          input.method ?? 'command',
          input.linkedBy ?? null,
        ],
      );
      await client.query('COMMIT');
      return {
        ok: true,
        link: toLink(rows[0] as Record<string, unknown>),
        action:
          decision.action === 'replace'
            ? 'replaced'
            : decision.reason.includes('re-affirming')
              ? 'reaffirmed'
              : 'created',
        reason: decision.reason,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('idx_account_links_username_unique')) {
        return {
          ok: false,
          code: 'conflict',
          reason: 'that Minecraft account is already linked to another Discord user',
        };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Operator confirmation of a pending link. */
  async verify(id: string): Promise<AccountLink | null> {
    const { rows } = await this.pool.query(
      `UPDATE account_links SET verified = TRUE, updated_at = now() WHERE id = $1
       RETURNING id, discord_user_id, minecraft_username, minecraft_uuid, verified, method,
                 created_at, updated_at`,
      [id],
    );
    return rows[0] ? toLink(rows[0] as Record<string, unknown>) : null;
  }

  async update(
    id: string,
    patch: { minecraftUsername?: string; verified?: boolean },
  ): Promise<AccountLink | null> {
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    if (patch.minecraftUsername !== undefined) {
      values.push(patch.minecraftUsername);
      sets.push(`minecraft_username = $${values.length}`);
    }
    if (patch.verified !== undefined) {
      values.push(patch.verified);
      sets.push(`verified = $${values.length}`);
    }
    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE account_links SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING id, discord_user_id, minecraft_username, minecraft_uuid, verified, method,
                 created_at, updated_at`,
      values,
    );
    return rows[0] ? toLink(rows[0] as Record<string, unknown>) : null;
  }

  async unlinkByDiscordUser(discordUserId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM account_links WHERE discord_user_id = $1',
      [discordUserId],
    );
    return rowCount ?? 0;
  }

  async unlink(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM account_links WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }
}
