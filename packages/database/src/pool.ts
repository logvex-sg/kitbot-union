import pg from 'pg';
import type { Logger } from '@unionkitbot/shared';

const { Pool } = pg;

export interface DatabaseOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  logger?: Logger;
}

let pool: pg.Pool | null = null;

export function createPool(options: DatabaseOptions): pg.Pool {
  const created = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
  });
  created.on('error', (error) => {
    options.logger?.error({ err: error }, 'postgres pool error');
  });
  return created;
}

export function getPool(options: DatabaseOptions): pg.Pool {
  if (!pool) pool = createPool(options);
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

export async function ping(activePool: pg.Pool): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    await activePool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

export type { pg };
