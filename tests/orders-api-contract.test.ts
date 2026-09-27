import { describe, expect, it } from 'vitest';
import {
  createAccountLinkSchema,
  createOrderSchema,
  createStorageScanSchema,
  orderListQuerySchema,
  storageMappingQuerySchema,
  updateStorageMappingSchema,
  webhookConfigSchema,
  webhookConfigUpdateSchema,
} from '@unionkitbot/schemas';
import { validateWebhookUrl } from '@unionkitbot/shared';

/**
 * Contract tests for the request schemas backing the orders, mappings and webhook routes.
 * These are the validation boundary, so malformed input must be rejected here rather than
 * reaching a repository.
 */
describe('order request schema', () => {
  it('accepts an explicit recipient with kits', () => {
    const parsed = createOrderSchema.parse({
      botId: '3f1e0d2c-1b2a-4c5d-8e9f-0a1b2c3d4e5f',
      recipient: 'Notch',
      kitIds: ['pvp', 'starter'],
      requestedBy: 'ui',
    });
    expect(parsed.recipient).toBe('Notch');
    expect(parsed.kitIds).toEqual(['pvp', 'starter']);
  });

  it('accepts a discord user id instead of a recipient', () => {
    const parsed = createOrderSchema.parse({
      discordUserId: '123456789012345678',
      kitIds: ['pvp'],
    });
    expect(parsed.discordUserId).toBe('123456789012345678');
    expect(parsed.recipient).toBeUndefined();
  });

  it('requires at least one kit', () => {
    expect(createOrderSchema.safeParse({ recipient: 'Notch' }).success).toBe(false);
    expect(createOrderSchema.safeParse({ recipient: 'Notch', kitIds: [] }).success).toBe(false);
  });

  it('defaults source and requestedBy', () => {
    const parsed = createOrderSchema.parse({ recipient: 'Notch', kitIds: ['pvp'] });
    expect(parsed.source).toBe('api');
    expect(parsed.requestedBy).toBe('api');
  });

  it('rejects an order with neither recipient nor discord user', () => {
    expect(createOrderSchema.safeParse({ kitIds: ['pvp'] }).success).toBe(false);
  });

  it('rejects a malformed botId', () => {
    expect(
      createOrderSchema.safeParse({ recipient: 'Notch', botId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('restricts the order list status filter to known values', () => {
    expect(orderListQuerySchema.safeParse({ status: 'COMPLETED' }).success).toBe(true);
    expect(orderListQuerySchema.safeParse({ status: 'MOSTLY_DONE' }).success).toBe(false);
  });
});

describe('storage request schemas', () => {
  it('accepts a scan with an origin and radius', () => {
    const parsed = createStorageScanSchema.parse({
      origin: { x: 1, y: 64, z: -20 },
      radius: 24,
      updateMappings: true,
      triggeredBy: 'operator',
    });
    expect(parsed.radius).toBe(24);
    expect(parsed.updateMappings).toBe(true);
  });

  it('rejects an out-of-range scan radius', () => {
    expect(createStorageScanSchema.safeParse({ radius: 5000 }).success).toBe(false);
  });

  it('requires the mapping override to name a kit or clear it explicitly', () => {
    expect(updateStorageMappingSchema.safeParse({ kitId: 'pvp' }).success).toBe(true);
    expect(updateStorageMappingSchema.safeParse({ kitId: null }).success).toBe(true);
    expect(updateStorageMappingSchema.safeParse({ kitId: '' }).success).toBe(false);
  });

  it('parses mapping filters', () => {
    const parsed = storageMappingQuerySchema.parse({ unresolvedOnly: 'true', limit: '25' });
    expect(parsed.unresolvedOnly).toBe(true);
    expect(parsed.limit).toBe(25);
  });
});

describe('account link request schema', () => {
  it('accepts a valid Minecraft username', () => {
    expect(
      createAccountLinkSchema.safeParse({
        discordUserId: '123',
        minecraftUsername: 'Player_1',
      }).success,
    ).toBe(true);
  });

  it('rejects usernames with invalid characters or length', () => {
    expect(
      createAccountLinkSchema.safeParse({ discordUserId: '123', minecraftUsername: 'ab' }).success,
    ).toBe(false);
    expect(
      createAccountLinkSchema.safeParse({ discordUserId: '123', minecraftUsername: 'bad name!' })
        .success,
    ).toBe(false);
    expect(
      createAccountLinkSchema.safeParse({
        discordUserId: '123',
        minecraftUsername: 'way_too_long_for_minecraft',
      }).success,
    ).toBe(false);
  });
});

describe('webhook request schema', () => {
  const validEvents = ['bot_death', 'delivery_failed'];

  it('accepts a full webhook configuration', () => {
    const parsed = webhookConfigSchema.parse({
      name: 'default',
      enabled: true,
      url: 'https://discord.com/api/webhooks/1/token',
      events: validEvents,
    });
    expect(parsed.name).toBe('default');
    expect(parsed.events).toEqual(validEvents);
  });

  it('defaults retry, timeout and rate-limit settings', () => {
    const parsed = webhookConfigSchema.parse({ name: 'default' });
    expect(parsed.retryCount).toBeGreaterThanOrEqual(0);
    expect(parsed.timeoutMs).toBeGreaterThan(0);
    expect(parsed.rateLimitPerMinute).toBeGreaterThan(0);
  });

  it('rejects unknown event kinds', () => {
    expect(
      webhookConfigSchema.safeParse({ name: 'default', events: ['not_an_event'] }).success,
    ).toBe(false);
  });

  it('requires a non-empty name', () => {
    expect(webhookConfigSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('allows a partial update without a name', () => {
    const parsed = webhookConfigUpdateSchema.parse({ enabled: false });
    expect(parsed.enabled).toBe(false);
  });
});

describe('webhook URL validation', () => {
  it('accepts https URLs', () => {
    const result = validateWebhookUrl('https://discord.com/api/webhooks/1/token');
    expect(result.ok).toBe(true);
  });
  it('accepts http URLs for internal endpoints', () => {
    expect(validateWebhookUrl('http://127.0.0.1:9000/hook').ok).toBe(true);
  });
  it('rejects non-http schemes', () => {
    expect(validateWebhookUrl('ftp://example.com/hook').ok).toBe(false);
    expect(validateWebhookUrl('file:///etc/passwd').ok).toBe(false);
  });
  it('rejects garbage', () => {
    expect(validateWebhookUrl('not a url').ok).toBe(false);
    expect(validateWebhookUrl(null).ok).toBe(false);
    expect(validateWebhookUrl(42).ok).toBe(false);
  });
});
