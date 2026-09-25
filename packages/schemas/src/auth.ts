import { z } from 'zod';

/** Bearer token is accepted as either an API key or an allowlisted Discord user id. */
export const apiKeyHeaderSchema = z.object({
  authorization: z.string().optional(),
  'x-api-key': z.string().optional(),
});

export const wsAuthSchema = z.object({
  token: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});

export const discordCommandSchema = z.object({
  user_id: z.string().min(1),
  guild_id: z.string().min(1).optional(),
  channel_id: z.string().min(1).optional(),
  interaction_id: z.string().min(1).optional(),
});
