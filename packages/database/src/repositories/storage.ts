import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { StorageScanResult } from '@unionkitbot/shared';
import { jsonb } from '../mappers.js';

export class StorageRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Persists a scan plus one row per logical container, all in a single transaction. */
  async saveScan(
    scan: StorageScanResult,
    deliveryId: string | null = null,
    contents: Map<string, unknown> = new Map(),
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO storage_scans
          (id, bot_id, delivery_id, dimension, origin_x, origin_y, origin_z, radius,
           logical_container_count, counts, inspected, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          scan.scanId,
          scan.botId,
          deliveryId,
          scan.dimension,
          scan.origin.x,
          scan.origin.y,
          scan.origin.z,
          scan.radius,
          scan.logicalContainerCount,
          jsonb(scan.counts),
          scan.inspected,
          scan.timestamp,
        ],
      );
      for (const container of scan.containers) {
        await client.query(
          `INSERT INTO storage_containers (id, scan_id, kind, block_name, group_key, x, y, z, contents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            scan.scanId,
            container.kind,
            container.blockName,
            container.groupKey,
            container.x,
            container.y,
            container.z,
            contents.has(container.groupKey) ? jsonb(contents.get(container.groupKey)) : null,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return scan.scanId;
  }

  async listScans(
    filter: { botId?: string; limit?: number; offset?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.botId) {
      values.push(filter.botId);
      clauses.push(`s.bot_id = $${values.length}`);
    }
    values.push(filter.limit ?? 100, filter.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT
         s.id,
         s.bot_id            AS "botId",
         s.delivery_id       AS "deliveryId",
         s.dimension,
         s.origin_x          AS x,
         s.origin_y          AS y,
         s.origin_z          AS z,
         s.radius,
         s.logical_container_count AS "logicalContainerCount",
         s.counts,
         s.inspected,
         s.created_at        AS "createdAt",
         COALESCE(c.containers, '[]'::json) AS containers
       FROM storage_scans s
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
           'id', sc.id, 'kind', sc.kind, 'blockName', sc.block_name, 'groupKey', sc.group_key,
           'x', sc.x, 'y', sc.y, 'z', sc.z, 'contents', sc.contents
         ) ORDER BY sc.y, sc.x, sc.z) AS containers
         FROM storage_containers sc WHERE sc.scan_id = s.id
       ) c ON TRUE
       ${where}
       ORDER BY s.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows as Array<Record<string, unknown>>;
  }
}
