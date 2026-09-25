import { readFile } from 'node:fs/promises';
import { botConfigFileSchema } from '@unionkitbot/schemas';
import type { Logger } from '@unionkitbot/shared';

export interface SeedStats {
  created: number;
  updated: number;
  unchanged: number;
}

interface BotRepoLike {
  list: () => Promise<Array<Record<string, unknown> & { id: string; name: string }>>;
  create: (input: Record<string, unknown>) => Promise<{ id: string }>;
  update: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Seeds bot_instances from the JSON file at MC_CONFIG_PATH.
 *
 * The file is an onboarding convenience, not the source of truth: PostgreSQL remains
 * authoritative afterwards. Existing rows are only touched when a field actually differs,
 * so a server host or auth edit made in the UI survives an agent restart.
 */
export async function seedBotsFromFile(
  filePath: string,
  repositories: { bots: unknown },
  logger: Logger,
): Promise<SeedStats> {
  const stats: SeedStats = { created: 0, updated: 0, unchanged: 0 };

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') {
      logger.debug({ filePath }, 'no bot config file present; skipping seed');
      return stats;
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(
      `bot config at ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = botConfigFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'bots'}: ${issue.message}`)
      .join('; ');
    throw new Error(`bot config at ${filePath} is invalid: ${issues}`);
  }

  const repo = repositories.bots as BotRepoLike;
  const existing = await repo.list();

  for (const entry of parsed.data.bots) {
    const match = existing.find((bot) => bot.name === entry.name);

    if (!match) {
      await repo.create({
        name: entry.name,
        username: entry.username,
        serverHost: entry.serverHost,
        serverPort: entry.serverPort,
        serverVersion: entry.serverVersion,
        authType: entry.authType,
        enabled: entry.enabled,
        autoConnect: entry.autoConnect,
        settings: entry.settings,
      });
      stats.created += 1;
      logger.info({ bot: entry.name }, 'seeded bot from config file');
      continue;
    }

    const patch: Record<string, unknown> = {};
    if (match['username'] !== entry.username) patch['username'] = entry.username;
    if (match['serverHost'] !== entry.serverHost) patch['serverHost'] = entry.serverHost;
    if (Number(match['serverPort']) !== entry.serverPort) patch['serverPort'] = entry.serverPort;
    if ((match['serverVersion'] ?? null) !== entry.serverVersion)
      patch['serverVersion'] = entry.serverVersion;
    if (match['authType'] !== entry.authType) patch['authType'] = entry.authType;

    if (Object.keys(patch).length === 0) {
      stats.unchanged += 1;
      continue;
    }
    await repo.update(match.id, patch);
    stats.updated += 1;
    logger.info({ bot: entry.name, fields: Object.keys(patch) }, 'updated bot from config file');
  }

  return stats;
}
