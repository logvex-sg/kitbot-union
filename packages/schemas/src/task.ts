import { z } from 'zod';
import { taskPrioritySchema, taskTypeSchema, uuidSchema, integerVec3Schema } from './common.js';

export const navigationPayloadSchema = z.object({
  target: integerVec3Schema.optional(),
  follow: z.string().max(16).optional(),
  /** Human readable label used in UI/Discord status output. */
  label: z.string().max(128).optional(),
});

export const deliveryPayloadSchema = z.object({
  recipient: z.string().min(1).max(16),
  kitIds: z.array(z.string().min(1).max(64)).min(1).max(16),
  /** Optional explicit destination; otherwise the bot moves to the recipient. */
  destination: integerVec3Schema.optional(),
  scanRadius: z.number().min(1).max(64).optional(),
  note: z.string().max(512).optional(),
});

export const createTaskSchema = z.object({
  botId: uuidSchema,
  type: taskTypeSchema,
  priority: taskPrioritySchema.optional(),
  payload: z.record(z.unknown()).default({}),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

export const taskIdParamsSchema = z.object({ id: uuidSchema });

export const taskFilterSchema = z.object({
  botId: uuidSchema.optional(),
  status: z.string().optional(),
  type: taskTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
