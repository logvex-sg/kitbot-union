import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  API_HOST: z.string().default('0.0.0.0'),
  API_SECRET: z.string().min(16, 'API_SECRET must be at least 16 characters'),
  WS_PATH: z.string().default('/api/ws'),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_ALLOWED_ROLES: z.string().default(''),
  DISCORD_ALLOWED_USERS: z.string().default(''),
  DISCORD_NOTIFY_CHANNEL_ID: z.string().optional(),
  MC_DEFAULT_HOST: z.string().default('localhost'),
  MC_DEFAULT_PORT: z.coerce.number().int().min(1).max(65535).default(25565),
  MC_DEFAULT_VERSION: z.string().optional(),
  MC_DEFAULT_USERNAME: z.string().default('unionkitbot'),
  MC_AUTH_TYPE: z.enum(['offline', 'microsoft']).default('offline'),
  MC_AUTHME_PASSWORD: z.string().optional(),
  MC_CONFIG_PATH: z.string().default('./config/bots.json'),

  // ------------------------------------------------- chest sign recognition
  /** Recognise kit types from signs placed on or near storage chests. */
  SIGN_AUTO_DETECT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** How far a sign may sit from a container and still be associated with it. */
  SIGN_MAX_DISTANCE: z.coerce.number().min(0.5).max(8).default(2.5),

  // ------------------------------------------------------------- delivery
  /** Distance within which items are dropped to the recipient. */
  DELIVERY_DROP_RANGE: z.coerce.number().min(1).max(16).default(4),
  /** Server teleport delay observed after a TPA is accepted. */
  DELIVERY_TELEPORT_WAIT_SECONDS: z.coerce.number().int().min(0).max(120).default(15),
  /** Post-delivery command execution. Disabled unless explicitly enabled. */
  POST_DELIVERY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  POST_DELIVERY_COMMAND: z.string().max(64).default('/kill'),

  // ------------------------------------------------------- outgoing TPA
  /** Command template the bot sends to request a teleport. `{player}` is substituted. */
  TPA_COMMAND: z.string().max(64).default('/tpa {player}'),
  TPA_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  TPA_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

  // -------------------------------------------------------- power saving
  POWER_SAVING_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  POWER_SAVING_IDLE_SCAN_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  POWER_SAVING_IDLE_TELEMETRY_SECONDS: z.coerce.number().int().min(5).max(3600).default(15),
  POWER_SAVING_AGGRESSIVE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ------------------------------------------------------------ webhooks
  /** Webhooks stay off unless a URL is configured and this is explicitly enabled. */
  WEBHOOK_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  WEBHOOK_URL: z.string().optional(),
  /** Comma separated allow-list; empty means every supported kind. */
  WEBHOOK_EVENTS: z.string().default(''),
  WEBHOOK_RETRY_COUNT: z.coerce.number().int().min(0).max(10).default(2),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),

  // -------------------------------------------------- discord account links
  /** Require operator confirmation before a link can be used for delivery. */
  LINK_REQUIRE_CONFIRMATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Allow one Discord user to hold several linked Minecraft accounts. */
  LINK_ALLOW_MULTIPLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  UI_ACCENT_COLOR: z.string().default('#5aa469'),
  CORS_ORIGINS: z.string().default('*'),
  LLM_CLASSIFIER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LLM_API_BASE: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  AGENT_HEARTBEAT_MS: z.coerce.number().int().min(1000).max(600_000).default(15_000),
});

export type Env = z.infer<typeof envSchema>;

export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}
