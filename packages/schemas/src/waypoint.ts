import { z } from 'zod';
import { waypointTypeSchema, uuidSchema } from './common.js';

export const createWaypointSchema = z.object({
  name: z.string().min(1).max(128),
  type: waypointTypeSchema,
  server: z.string().min(1).max(255),
  dimension: z.string().min(1).max(64).default('overworld'),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  botId: uuidSchema.nullable().optional(),
  playerId: uuidSchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const updateWaypointSchema = createWaypointSchema.partial();

export const waypointFilterSchema = z.object({
  type: waypointTypeSchema.optional(),
  server: z.string().optional(),
  botId: uuidSchema.optional(),
  search: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const waypointParamsSchema = z.object({ id: uuidSchema });
