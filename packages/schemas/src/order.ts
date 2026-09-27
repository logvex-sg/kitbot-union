import { z } from 'zod';
import {
  ORDER_STATES,
  ORDER_STATUSES,
  WEBHOOK_EVENT_KINDS,
  CONTAINER_KINDS,
} from '@unionkitbot/shared';
import { integerVec3Schema, paginationSchema, uuidSchema } from './common.js';

export const orderStateSchema = z.enum(ORDER_STATES);
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export const webhookEventKindSchema = z.enum(WEBHOOK_EVENT_KINDS);

/**
 * Order creation. Operators may give either explicit kit ids or a numeric code / shorthand,
 * which the API resolves against configured kits. Free text commands are never executed.
 */
export const createOrderSchema = z
  .object({
    botId: uuidSchema.optional(),
    kitIds: z.array(z.string().min(1).max(64)).min(1).max(16),
    /** Linked Minecraft account to deliver to. */
    recipient: z.string().min(1).max(16).optional(),
    /** Discord user id whose link should resolve the recipient. */
    discordUserId: z.string().min(1).max(64).optional(),
    requestedBy: z.string().min(1).max(128).default('api'),
    source: z.enum(['discord', 'api', 'chat', 'cli']).default('api'),
    note: z.string().max(512).optional(),
    /** Skip the item-reservation step; only valid for operator diagnostics. */
    skipReservation: z.boolean().default(false),
  })
  .refine((value) => Boolean(value.recipient ?? value.discordUserId), {
    message: 'either recipient or discordUserId is required',
    path: ['recipient'],
  });

export const orderListQuerySchema = paginationSchema.extend({
  botId: uuidSchema.optional(),
  status: orderStatusSchema.optional(),
  state: orderStateSchema.optional(),
  discordUserId: z.string().max(64).optional(),
  recipient: z.string().max(16).optional(),
});

export const orderCodeParamsSchema = z.object({
  code: z.coerce.number().int().positive().max(1_000_000),
});

/** Manual override of a recognised kit on a storage location. */
export const updateStorageMappingSchema = z.object({
  kitId: z.string().min(1).max(64).nullable().optional(),
  /** Enables/disables the manual override; a null kitId clears it. */
  overrideEnabled: z.boolean().optional(),
  notes: z.string().max(512).optional(),
});

export const storageMappingQuerySchema = paginationSchema.extend({
  botId: uuidSchema.optional(),
  kitId: z.string().max(64).optional(),
  dimension: z.string().max(64).optional(),
  /** Only return mappings whose match was ambiguous or failed. */
  unresolvedOnly: z.coerce.boolean().default(false),
});

/** Explicitly request a re-scan of a storage area. */
export const createStorageScanSchema = z.object({
  botId: uuidSchema.optional(),
  origin: integerVec3Schema.optional(),
  radius: z.number().min(1).max(64).optional(),
  /** Re-run sign association and update the durable mappings. */
  updateMappings: z.boolean().default(true),
  triggeredBy: z.string().max(64).default('manual'),
});

export const kitStorageConfigSchema = z.object({
  autoDetect: z.boolean().default(true),
});

/** Discord <-> Minecraft account link creation. */
export const createAccountLinkSchema = z.object({
  discordUserId: z.string().min(1).max(64),
  minecraftUsername: z
    .string()
    .min(3)
    .max(16)
    .regex(/^[A-Za-z0-9_]+$/, 'invalid Minecraft username'),
  /** Only settable by an operator; self-service links follow LINK_REQUIRE_CONFIRMATION. */
  verified: z.boolean().optional(),
  linkedBy: z.string().max(128).optional(),
  method: z.enum(['command', 'operator', 'import']).default('operator'),
});

export const updateAccountLinkSchema = z.object({
  minecraftUsername: z
    .string()
    .min(3)
    .max(16)
    .regex(/^[A-Za-z0-9_]+$/, 'invalid Minecraft username')
    .optional(),
  verified: z.boolean().optional(),
});

export const accountLinkQuerySchema = paginationSchema.extend({
  discordUserId: z.string().max(64).optional(),
  minecraftUsername: z.string().max(16).optional(),
  verified: z.coerce.boolean().optional(),
});

/** Webhook configuration. The URL may be set but is returned redacted. */
export const webhookConfigSchema = z.object({
  name: z.string().min(1).max(64).default('default'),
  enabled: z.boolean().default(false),
  url: z.string().url().max(2048).nullable().optional(),
  events: z.array(webhookEventKindSchema).max(16).default([]),
  retryCount: z.number().int().min(0).max(10).default(2),
  timeoutMs: z.number().int().min(500).max(60_000).default(5_000),
  rateLimitPerMinute: z.number().int().min(1).max(600).default(30),
  includePayload: z.boolean().default(false),
});

export const webhookConfigUpdateSchema = webhookConfigSchema.partial();

export const powerSavingSchema = z.object({
  enabled: z.boolean().optional(),
  idleScanIntervalSeconds: z.number().int().min(5).max(3600).optional(),
  idleTelemetryIntervalSeconds: z.number().int().min(5).max(3600).optional(),
  aggressive: z.boolean().optional(),
});

export const deathHistoryQuerySchema = paginationSchema.extend({
  botId: uuidSchema.optional(),
  recovered: z.coerce.boolean().optional(),
});

export const deliveryHistoryQuerySchema = paginationSchema.extend({
  botId: uuidSchema.optional(),
  orderId: uuidSchema.optional(),
  recipient: z.string().max(16).optional(),
  outcome: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'TIMEOUT']).optional(),
});

export const navigationFailureQuerySchema = paginationSchema.extend({
  botId: uuidSchema.optional(),
  stuckOnly: z.coerce.boolean().default(false),
});

export const containerKindSchema = z.enum(CONTAINER_KINDS);

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type WebhookConfigInput = z.infer<typeof webhookConfigSchema>;
