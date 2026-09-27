import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { KitDefinition } from '@unionkitbot/shared';

export class KitRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<KitDefinition[]> {
    const { rows } = await this.pool.query(
      `SELECT k.id, k.name, k.description, k.enabled, k.aliases, k.storage_auto_detect,
              COALESCE(
                json_agg(json_build_object('item', ki.item, 'count', ki.count) ORDER BY ki.item)
                  FILTER (WHERE ki.id IS NOT NULL),
                '[]'
              ) AS items
       FROM kits k
       LEFT JOIN kit_items ki ON ki.kit_id = k.id
       GROUP BY k.id, k.name, k.description, k.enabled, k.aliases, k.storage_auto_detect
       ORDER BY k.id`,
    );
    return rows.map((r) => {
      const kit: KitDefinition = {
        id: String(r['id']),
        name: String(r['name']),
        enabled: Boolean(r['enabled']),
        items: (r['items'] as Array<{ item: string; count: number }>) ?? [],
        aliases: (r['aliases'] as string[] | null) ?? [],
        storageAutoDetect: Boolean(r['storage_auto_detect']),
      };
      if (r['description']) kit.description = String(r['description']);
      return kit;
    });
  }

  async get(id: string): Promise<KitDefinition | null> {
    const all = await this.list();
    return all.find((k) => k.id === id) ?? null;
  }

  async upsert(kit: KitDefinition): Promise<KitDefinition> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO kits (id, name, description, enabled, aliases, storage_auto_detect, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
           enabled = EXCLUDED.enabled, aliases = EXCLUDED.aliases,
           storage_auto_detect = EXCLUDED.storage_auto_detect, updated_at = now()`,
        [
          kit.id,
          kit.name,
          kit.description ?? null,
          kit.enabled ?? true,
          kit.aliases ?? [],
          kit.storageAutoDetect ?? true,
        ],
      );
      await client.query('DELETE FROM kit_items WHERE kit_id = $1', [kit.id]);
      for (const item of kit.items) {
        await client.query('INSERT INTO kit_items (id, kit_id, item, count) VALUES ($1,$2,$3,$4)', [
          randomUUID(),
          kit.id,
          item.item,
          item.count,
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const created = await this.get(kit.id);
    if (!created) throw new Error(`kit ${kit.id} disappeared after upsert`);
    return created;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM kits WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
