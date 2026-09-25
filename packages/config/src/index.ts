import { config as loadDotenv } from 'dotenv';
import { envSchema, splitList, type Env } from '@unionkitbot/schemas';
import { mergeAgentSettings, type AgentSettings } from '@unionkitbot/shared';

loadDotenv();

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid environment configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export interface AppConfig extends Env {
  discordAllowedRoles: string[];
  discordAllowedUsers: string[];
  corsOrigins: string[];
  /** Derived default agent settings; per-bot overrides are merged on top. */
  defaultAgentSettings: AgentSettings;
}

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, force = false): AppConfig {
  if (cached && !force) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigError(issues);
  }
  const value = parsed.data;
  cached = {
    ...value,
    discordAllowedRoles: splitList(value.DISCORD_ALLOWED_ROLES),
    discordAllowedUsers: splitList(value.DISCORD_ALLOWED_USERS),
    corsOrigins: splitList(value.CORS_ORIGINS),
    defaultAgentSettings: defaultAgentSettings(value),
  };
  return cached;
}

export function defaultAgentSettings(
  env: Pick<Env, 'AGENT_HEARTBEAT_MS' | 'MC_CONFIG_PATH'>,
): AgentSettings {
  void env;
  return {
    reconnect: { baseDelayMs: 2_000, maxDelayMs: 300_000, maxAttempts: 50, jitter: true },
    navigation: {
      goalRadius: 2,
      pathTimeoutMs: 90_000,
      stuckCheckIntervalMs: 1_000,
      stuckThreshold: 6_000,
      replanCooldownMs: 1_500,
    },
    storage: { scanRadius: 8, inspectContents: true },
    chat: { respondToGreetings: true, greetingMessage: 'hello', responseCooldownMs: 15_000 },
    delivery: { approachDistance: 2, verifyTimeoutMs: 8_000, maxRetries: 2 },
    tpa: {
      enabled: true,
      mode: 'TRUSTED_ONLY',
      timeoutMs: 60_000,
      trustedPlayers: [],
      blockedPlayers: [],
      customRules: {},
      cooldownMs: 5_000,
      maxPending: 5,
    },
  };
}

export { mergeAgentSettings };

export function resetConfigCache(): void {
  cached = null;
}
