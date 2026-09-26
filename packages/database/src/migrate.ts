import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import type { Logger } from '@unionkitbot/shared';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies SQL migrations from `dir` in filename order exactly once, tracked in
 * `schema_migrations`. Safe to run on every boot.
 */
export async function runMigrations(
  pool: pg.Pool,
  dir: string,
  logger?: Logger,
): Promise<MigrationResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set<string>(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (r) => r.name,
    ),
  );
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const file of files) {
    if (applied.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      result.applied.push(file);
      logger?.info({ file }, 'migration applied');
    } catch (error) {
      await client.query('ROLLBACK');
      logger?.error({ err: error, file }, 'migration failed');
      throw error;
    } finally {
      client.release();
    }
  }
  return result;
}
