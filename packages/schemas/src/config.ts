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
