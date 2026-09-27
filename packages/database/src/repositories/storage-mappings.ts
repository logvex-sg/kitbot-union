import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { ContainerRecord, StorageSignAttach } from '@unionkitbot/shared';
import { effectiveKitId, signCandidates } from '@unionkitbot/shared';

export interface StorageMappingRecord {
  id: string;
  botId: string;
  server: string;
  dimension: string;
  groupKey: string;
  kind: string;
  blockName: string;
  x: number;
  y: number;
  z: number;
  signLines: string[] | null;
  signNormalized: string | null;
  detectedKitId: string | null;
  matchAmbiguous: boolean;
  matchReason: string | null;
  overrideKitId: string | null;
  overrideEnabled: boolean;
  overrideBy: string | null;
  scanId: string | null;
  /** Detection or override, whichever applies. */
  effectiveKitId: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertMappingInput {
  botId: string;
  server: string;
  dimension: string;
  container: ContainerRecord;
  attach: StorageSignAttach | null;
  detectedKitId: string | null;
  ambiguous: boolean;
  reason: string;
  scanId: string | null;
}

const SELECT = `
  SELECT id, bot_id, server, dimension, group_key, kind, block_name, x, y, z, sign_lines,
         sign_normalized, detected_kit_id, match_ambiguous, match_reason, override_kit_id,
         override_enabled, override_by, scan_id, last_seen_at, created_at, updated_at
  FROM kit_storage_mappings`;

function toRecord(row: Record<string, unknown>): StorageMappingRecord {
  const detected = (row['detected_kit_id'] as string | null) ?? null;
  const override = (row['override_kit_id'] as string | null) ?? null;
  const overrideEnabled = Boolean(row['override_enabled']);
  return {
    id: String(row['id']),
    botId: String(row['bot_id']),
    server: String(row['server']),
    dimension: String(row['dimension']),
    groupKey: String(row['group_key']),
    kind: String(row['kind']),
    blockName: String(row['block_name']),
    x: Number(row['x']),
    y: Number(row['y']),
    z: Number(row['z']),
    signLines: (row['sign_lines'] as string[] | null) ?? null,
    signNormalized: (row['sign_normalized'] as string | null) ?? null,
    detectedKitId: detected,
    matchAmbiguous: Boolean(row['match_ambiguous']),
    matchReason: (row['match_reason'] as string | null) ?? null,
    overrideKitId: override,
    overrideEnabled,
    overrideBy: (row['override_by'] as string | null) ?? null,
    scanId: (row['scan_id'] as string | null) ?? null,
    effectiveKitId: effectiveKitId(detected, override, overrideEnabled),
    lastSeenAt: new Date(String(row['last_seen_at'])).toISOString(),
    createdAt: new Date(String(row['created_at'])).toISOString(),
    updatedAt: new Date(String(row['updated_at'])).toISOString(),
  };
}

/**
 * Durable kit <-> storage mappings.
 *
 * A mapping survives the scan that produced it: re-scanning the same location updates the
 * existing row (keyed by bot, dimension and container group key) instead of inserting a
 * duplicate, so a manual override is never lost to an unrelated re-scan.
 */
export class StorageMappingRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Inserts or refreshes a mapping. Manual overrides are preserved: the upsert only
   * rewrites detection columns, never the override columns.
   */
  async upsert(input: UpsertMappingInput): Promise<StorageMappingRecord> {
    const lines = input.attach?.sign.lines ?? null;
    const normalized = input.attach ? signCandidates(input.attach.sign.lines) : [];
    const { rows } = await this.pool.query(
      `INSERT INTO kit_storage_mappings
         (id, bot_id, server, dimension, group_key, kind, block_name, x, y, z, sign_lines,
          sign_normalized, detected_kit_id, match_ambiguous, match_reason, scan_id,
          last_seen_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), now(), now())
       ON CONFLICT (bot_id, dimension, group_key) DO UPDATE SET
         kind            = EXCLUDED.kind,
         block_name      = EXCLUDED.block_name,
         x               = EXCLUDED.x,
         y               = EXCLUDED.y,
         z               = EXCLUDED.z,
         sign_lines      = EXCLUDED.sign_lines,
         sign_normalized = EXCLUDED.sign_normalized,
         detected_kit_id = EXCLUDED.detected_kit_id,
         match_ambiguous = EXCLUDED.match_ambiguous,
         match_reason    = EXCLUDED.match_reason,
         scan_id         = EXCLUDED.scan_id,
         server          = EXCLUDED.server,
         last_seen_at    = now(),
         updated_at      = now()
       RETURNING id, bot_id, server, dimension, group_key, kind, block_name, x, y, z, sign_lines,
                 sign_normalized, detected_kit_id, match_ambiguous, match_reason, override_kit_id,
                 override_enabled, override_by, scan_id, last_seen_at, created_at, updated_at`,
      [
        randomUUID(),
        input.botId,
        input.server,
        input.dimension,
        input.container.groupKey,
        input.container.kind,
        input.container.blockName,
        input.container.x,
        input.container.y,
        input.container.z,
        lines,
        normalized.join(' | ') || null,
        input.detectedKitId,
        input.ambiguous,
        input.reason,
        input.scanId,
      ],
    );
    return toRecord(rows[0] as Record<string, unknown>);
  }

  /** Records an observed container that has no sign, so operators can assign one later. */
  async upsertUnmatched(
    container: ContainerRecord,
    params: { botId: string; server: string; dimension: string; scanId: string | null },
  ): Promise<StorageMappingRecord> {
    return this.upsert({
      ...params,
      container,
      attach: null,
      detectedKitId: null,
      ambiguous: false,
      reason: 'no sign associated with this container',
    });
  }

  async get(id: string): Promise<StorageMappingRecord | null> {
    const { rows } = await this.pool.query(`${SELECT} WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0] as Record<string, unknown>) : null;
  }

  async getByGroup(
    botId: string,
    dimension: string,
    groupKey: string,
  ): Promise<StorageMappingRecord | null> {
    const { rows } = await this.pool.query(
      `${SELECT} WHERE bot_id = $1 AND dimension = $2 AND group_key = $3`,
      [botId, dimension, groupKey],
    );
    return rows[0] ? toRecord(rows[0] as Record<string, unknown>) : null;
  }

  async list(
    filter: {
      botId?: string;
      kitId?: string;
      dimension?: string;
      unresolvedOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<StorageMappingRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.botId) {
      values.push(filter.botId);
      clauses.push(`bot_id = $${values.length}`);
    }
    if (filter.dimension) {
      values.push(filter.dimension);
      clauses.push(`dimension = $${values.length}`);
    }
    if (filter.kitId) {
      // Match either the override (when enabled) or the detected kit.
      values.push(filter.kitId);
      clauses.push(
        `((override_enabled AND override_kit_id = $${values.length}) OR detected_kit_id = $${values.length})`,
      );
    }
    if (filter.unresolvedOnly) {
      clauses.push(
        `(match_ambiguous = TRUE OR (detected_kit_id IS NULL AND (override_enabled = FALSE OR override_kit_id IS NULL)))`,
      );
    }
    values.push(filter.limit ?? 200, filter.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `${SELECT} ${where} ORDER BY updated_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows.map((row) => toRecord(row as Record<string, unknown>));
  }

  /** All containers currently mapped to a kit, used to find where a kit is stocked. */
  async findByKit(botId: string, kitId: string): Promise<StorageMappingRecord[]> {
    const { rows } = await this.pool.query(
      `${SELECT}
       WHERE bot_id = $1
         AND ((override_enabled AND override_kit_id = $2) OR detected_kit_id = $2)
       ORDER BY last_seen_at DESC`,
      [botId, kitId],
    );
    return rows.map((row) => toRecord(row as Record<string, unknown>));
  }

  /**
   * Sets or clears a manual override. Passing a null kit id disables the override so
   * detection takes effect again.
   */
  async setOverride(
    id: string,
    kitId: string | null,
    by: string,
    enabled = true,
  ): Promise<StorageMappingRecord | null> {
    const { rows } = await this.pool.query(
      `UPDATE kit_storage_mappings
       SET override_kit_id = $2,
           override_enabled = $3,
           override_by = $4,
           override_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING id, bot_id, server, dimension, group_key, kind, block_name, x, y, z, sign_lines,
                 sign_normalized, detected_kit_id, match_ambiguous, match_reason, override_kit_id,
                 override_enabled, override_by, scan_id, last_seen_at, created_at, updated_at`,
      [id, kitId, kitId ? enabled : false, by],
    );
    return rows[0] ? toRecord(rows[0] as Record<string, unknown>) : null;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM kit_storage_mappings WHERE id = $1',
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Counts per effective kit, for the UI's storage summary. */
  async summary(botId?: string): Promise<Array<Record<string, unknown>>> {
    const values: unknown[] = [];
    let where = '';
    if (botId) {
      values.push(botId);
      where = `WHERE bot_id = $${values.length}`;
    }
    const { rows } = await this.pool.query(
      `SELECT COALESCE(
                CASE WHEN override_enabled THEN override_kit_id ELSE detected_kit_id END,
                'unassigned') AS "kitId",
              COUNT(*)::int AS count,
              SUM(CASE WHEN match_ambiguous THEN 1 ELSE 0 END)::int AS ambiguous
       FROM kit_storage_mappings ${where}
       GROUP BY 1 ORDER BY count DESC`,
      values,
    );
    return rows as Array<Record<string, unknown>>;
  }
}
