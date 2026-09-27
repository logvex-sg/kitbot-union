import { config as loadDotenv } from 'dotenv';
import { envSchema, splitList, type Env } from '@unionkitbot/schemas';
import { mergeAgentSettings, parseWebhookEventKinds, type AgentSettings } from '@unionkitbot/shared';

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
  env: Pick<
    Env,
    | 'AGENT_HEARTBEAT_MS'
    | 'MC_CONFIG_PATH'
    | 'SIGN_AUTO_DETECT'
    | 'SIGN_MAX_DISTANCE'
    | 'DELIVERY_DROP_RANGE'
    | 'DELIVERY_TELEPORT_WAIT_SECONDS'
    | 'TPA_COMMAND'
    | 'TPA_TIMEOUT_SECONDS'
    | 'TPA_MAX_RETRIES'
    | 'POST_DELIVERY_ENABLED'
    | 'POST_DELIVERY_COMMAND'
    | 'POWER_SAVING_ENABLED'
    | 'POWER_SAVING_IDLE_SCAN_SECONDS'
    | 'POWER_SAVING_IDLE_TELEMETRY_SECONDS'
    | 'POWER_SAVING_AGGRESSIVE'
    | 'WEBHOOK_ENABLED'
    | 'WEBHOOK_URL'
    | 'WEBHOOK_EVENTS'
    | 'WEBHOOK_RETRY_COUNT'
    | 'WEBHOOK_TIMEOUT_MS'
    | 'WEBHOOK_RATE_LIMIT_PER_MINUTE'
    | 'LINK_REQUIRE_CONFIRMATION'
    | 'LINK_ALLOW_MULTIPLE'
  >,
): AgentSettings {
  return {
    reconnect: { baseDelayMs: 2_000, maxDelayMs: 300_000, maxAttempts: 50, jitter: true },
    navigation: {
      goalRadius: 2,
      pathTimeoutMs: 90_000,
      stuckCheckIntervalMs: 1_000,
      stuckThreshold: 6_000,
      replanCooldownMs: 1_500,
      maxRepathAttempts: 12,
      waypointTolerance: 2,
      avoidDangerousBlocks: true,
      canDig: false,
    },
    storage: {
      scanRadius: 8,
      inspectContents: true,
      signAutoDetect: env.SIGN_AUTO_DETECT,
      signMaxDistance: env.SIGN_MAX_DISTANCE,
    },
    chat: { respondToGreetings: true, greetingMessage: 'hello', responseCooldownMs: 15_000 },
    delivery: {
      approachDistance: 2,
      verifyTimeoutMs: 8_000,
      maxRetries: 2,
      dropRange: env.DELIVERY_DROP_RANGE,
      postDelivery: {
        // Disabled by default: running /kill is a server-specific decision, never a default.
        enabled: env.POST_DELIVERY_ENABLED,
        command: env.POST_DELIVERY_COMMAND,
      },
    },
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
    outgoingTpa: {
      enabled: true,
      command: env.TPA_COMMAND,
      timeoutSeconds: env.TPA_TIMEOUT_SECONDS,
      maxRetries: env.TPA_MAX_RETRIES,
      teleportWaitSeconds: env.DELIVERY_TELEPORT_WAIT_SECONDS,
    },
    powerSaving: {
      enabled: env.POWER_SAVING_ENABLED,
      idleScanIntervalSeconds: env.POWER_SAVING_IDLE_SCAN_SECONDS,
      idleTelemetryIntervalSeconds: env.POWER_SAVING_IDLE_TELEMETRY_SECONDS,
      aggressive: env.POWER_SAVING_AGGRESSIVE,
    },
    webhooks: {
      enabled: env.WEBHOOK_ENABLED,
      url: env.WEBHOOK_URL && env.WEBHOOK_URL.length > 0 ? env.WEBHOOK_URL : null,
      events: parseWebhookEventKinds(splitList(env.WEBHOOK_EVENTS)),
      retryCount: env.WEBHOOK_RETRY_COUNT,
      timeoutMs: env.WEBHOOK_TIMEOUT_MS,
      rateLimitPerMinute: env.WEBHOOK_RATE_LIMIT_PER_MINUTE,
      includePayload: false,
    },
    linking: {
      requireConfirmation: env.LINK_REQUIRE_CONFIRMATION,
      validateUsername: true,
      uniqueMinecraftAccount: true,
      allowMultiplePerDiscordUser: env.LINK_ALLOW_MULTIPLE,
    },
    packArea: null,
  };
}

export { mergeAgentSettings };

export function resetConfigCache(): void {
  cached = null;
}
