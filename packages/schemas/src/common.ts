import { z } from 'zod';
import {
  BOT_STATES,
  TASK_PRIORITIES,
  TASK_TYPES,
  TPA_MODES,
  WAYPOINT_TYPES,
} from '@unionkitbot/shared';

export const uuidSchema = z.string().uuid();
export const botStateSchema = z.enum(BOT_STATES);
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export const taskTypeSchema = z.enum(TASK_TYPES);
export const tpaModeSchema = z.enum(TPA_MODES);
export const waypointTypeSchema = z.enum(WAYPOINT_TYPES);

export const vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const integerVec3Schema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});

export const itemRequirementSchema = z.object({
  item: z
    .string()
    .min(1)
    .max(128)
    .transform((v) => v.trim().toLowerCase()),
  count: z.number().int().positive().max(2304),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
