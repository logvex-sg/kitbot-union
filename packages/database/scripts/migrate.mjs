#!/usr/bin/env node
// Standalone migration runner for `pnpm db:migrate` and `scripts/migrate.sh`.
// The agent also runs migrations on boot; this applies them without starting a bot.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createLogger } from '@unionkitbot/shared';
import { runMigrations } from '../dist/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.UKB_MIGRATIONS_DIR ?? path.resolve(here, '../../../migrations');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required to run migrations');
  process.exit(1);
}

const logger = createLogger({ name: 'migrate', level: process.env.LOG_LEVEL ?? 'info' });
const pool = new pg.Pool({ connectionString });

try {
  const result = await runMigrations(pool, dir, logger);
  logger.info(
    { dir, applied: result.applied.length, skipped: result.skipped.length },
    'migrations complete',
  );
} catch (error) {
  logger.error({ err: error }, 'migration run failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
