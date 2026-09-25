import { z } from 'zod';
import { itemRequirementSchema } from './common.js';

export const kitSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'kit id must be lowercase alphanumeric with dash/underscore'),
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional(),
  items: z.array(itemRequirementSchema).min(1).max(64),
  enabled: z.boolean().default(true),
});

export const updateKitSchema = kitSchema.partial().omit({ id: true });

export const kitParamsSchema = z.object({ id: z.string().min(1).max(64) });
