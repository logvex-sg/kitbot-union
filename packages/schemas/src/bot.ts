import { z } from 'zod';
import { botStateSchema, uuidSchema } from './common.js';

export const serverConfigSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  version: z.string().max(32).optional(),
  auth: z.enum(['offline', 'microsoft']).default('offline'),
  username: z
    .string()
    .min(1)
    .max(16)
    .regex(/^[A-Za-z0-9_]+$/, 'invalid Minecraft username'),
  password: z.string().max(256).optional(),
  authmePassword: z.string().max(256).optional(),
});

export const createBotSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'bot name may only contain letters, numbers, dash and underscore'),
  username: z
    .string()
    .min(1)
    .max(16)
    .regex(/^[A-Za-z0-9_]+$/),
  serverHost: z.string().min(1).max(255),
  serverPort: z.number().int().min(1).max(65535).default(25565),
  serverVersion: z.string().max(32).optional(),
  authType: z.enum(['offline', 'microsoft']).default('offline'),
  enabled: z.boolean().default(true),
  autoConnect: z.boolean().default(true),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const updateBotSchema = createBotSchema.partial().omit({ name: true });

export const botIdParamsSchema = z.object({ id: uuidSchema });

export const botSettingsSchema = z.object({
  tpa: z
    .object({
      enabled: z.boolean(),
      mode: z.enum(['DISABLED', 'TRUSTED_ONLY', 'ALLOW_LIST', 'MANUAL', 'CUSTOM_RULES']),
      timeoutMs: z.number().int().min(1000).max(600_000),
      trustedPlayers: z.array(z.string().max(16)),
      blockedPlayers: z.array(z.string().max(16)),
      customRules: z.record(z.string(), z.boolean()),
      cooldownMs: z.number().int().min(0).max(600_000),
      maxPending: z.number().int().min(1).max(1000),
    })
    .partial(),
  navigation: z
    .object({
      goalRadius: z.number().min(0.1).max(64),
      pathTimeoutMs: z.number().int().min(1000).max(600_000),
      stuckCheckIntervalMs: z.number().int().min(250).max(60_000),
      stuckThreshold: z.number().int().min(500).max(600_000),
      replanCooldownMs: z.number().int().min(0).max(60_000),
    })
    .partial(),
  storage: z
    .object({
      scanRadius: z.number().min(1).max(64),
      inspectContents: z.boolean(),
    })
    .partial(),
  reconnect: z
    .object({
      baseDelayMs: z.number().int().min(100).max(60_000),
      maxDelayMs: z.number().int().min(1000).max(3_600_000),
      maxAttempts: z.number().int().min(1).max(1000),
      jitter: z.boolean(),
    })
    .partial(),
  chat: z
    .object({
      respondToGreetings: z.boolean(),
      greetingMessage: z.string().max(256),
      responseCooldownMs: z.number().int().min(0).max(600_000),
    })
    .partial(),
  delivery: z
    .object({
      approachDistance: z.number().min(1).max(16),
      verifyTimeoutMs: z.number().int().min(500).max(120_000),
      maxRetries: z.number().int().min(0).max(10),
    })
    .partial(),
});

/**
 * Shape of the optional JSON bot file referenced by MC_CONFIG_PATH. It seeds
 * bot_instances on agent startup; PostgreSQL remains the source of truth afterwards.
 */
export const botConfigFileSchema = z.object({
  bots: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(
            /^[a-zA-Z0-9_-]+$/,
            'bot name may only contain letters, numbers, dash and underscore',
          ),
        username: z
          .string()
          .min(1)
          .max(16)
          .regex(/^[A-Za-z0-9_]+$/),
        serverHost: z.string().min(1).max(255),
        serverPort: z.number().int().min(1).max(65535).default(25565),
        serverVersion: z.string().max(32).nullable().default(null),
        authType: z.enum(['offline', 'microsoft']).default('offline'),
        enabled: z.boolean().default(true),
        autoConnect: z.boolean().default(true),
        settings: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
});

export type BotConfigFile = z.infer<typeof botConfigFileSchema>;
export type BotConfigFileEntry = BotConfigFile['bots'][number];

export const botSnapshotSchema = z.object({
  botId: uuidSchema,
  username: z.string(),
  server: z.string(),
  state: botStateSchema,
  connected: z.boolean(),
  position: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      dimension: z.string(),
      yaw: z.number().optional(),
      pitch: z.number().optional(),
    })
    .nullable(),
  health: z.number().nullable(),
  food: z.number().nullable(),
  dimension: z.string(),
  uptimeMs: z.number(),
  reconnectCount: z.number(),
  currentTaskId: z.string().nullable(),
  currentTaskType: z.string().nullable(),
  target: z.string().nullable(),
  pathfinding: z.string().nullable(),
  inventory: z
    .object({
      usedSlots: z.number(),
      totalSlots: z.number(),
      emptySlots: z.number(),
      items: z.array(
        z.object({
          name: z.string(),
          count: z.number(),
          slot: z.number(),
          displayName: z.string().optional(),
        }),
      ),
    })
    .nullable(),
  lastHeartbeat: z.string(),
});
