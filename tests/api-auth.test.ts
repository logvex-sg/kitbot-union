import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../apps/api/src/auth.js';
import { createLogger } from '@unionkitbot/shared';

const logger = createLogger({ name: 'test', level: 'silent' });

const request = (headers: Record<string, string> = {}) => ({ headers, url: '/api/bots' }) as never;

const service = (patch: { secret?: string; users?: string[]; disabled?: boolean } = {}) =>
  new AuthService({
    apiSecret: patch.secret ?? 'super-secret-token',
    allowedDiscordUsers: patch.users ?? ['discord-user-1'],
    logger,
    ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
  });

describe('api authentication', () => {
  it('accepts a bearer token', () => {
    const principal = service().authenticate(
      request({ authorization: 'Bearer super-secret-token' }),
    );
    expect(principal).toEqual({ id: 'api', kind: 'api-key' });
  });

  it('accepts the x-api-key header', () => {
    const principal = service().authenticate(request({ 'x-api-key': 'super-secret-token' }));
    expect(principal?.kind).toBe('api-key');
  });

  it('is case-insensitive on the scheme but not the token', () => {
    expect(
      service().authenticate(request({ authorization: 'bearer super-secret-token' })),
    ).not.toBeNull();
    expect(
      service().authenticate(request({ authorization: 'Bearer SUPER-SECRET-TOKEN' })),
    ).toBeNull();
  });

  it('rejects missing, malformed and wrong tokens', () => {
    expect(service().authenticate(request())).toBeNull();
    expect(service().authenticate(request({ authorization: 'Basic abc' }))).toBeNull();
    expect(service().authenticate(request({ 'x-api-key': 'wrong' }))).toBeNull();
    expect(service().authenticate(request({ 'x-api-key': 'super-secret-toke' }))).toBeNull();
    expect(service().authenticate(request({ 'x-api-key': 'super-secret-token-extra' }))).toBeNull();
  });

  it('accepts an allowlisted discord user identity', () => {
    const principal = service().authenticate(request({ 'x-api-key': 'discord-user-1' }));
    expect(principal?.kind).toBe('discord');
  });

  it('authenticateToken follows the same rules (websocket path)', () => {
    expect(service().authenticateToken('super-secret-token')?.kind).toBe('api-key');
    expect(service().authenticateToken('discord-user-1')?.kind).toBe('discord');
    expect(service().authenticateToken('nope')).toBeNull();
    expect(service().authenticateToken(null)).toBeNull();
    expect(service().authenticateToken(undefined)).toBeNull();
  });

  it('requireAuth replies 401 without a valid token and attaches the principal', async () => {
    const auth = service();
    const send = vi.fn();
    const reply = { code: vi.fn(() => ({ send })) };
    const rejected = request();
    await auth.requireAuth(rejected, reply as never);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: 'unauthorized' }));

    const reply2 = { code: vi.fn(() => ({ send: vi.fn() })) };
    const accepted = request({ 'x-api-key': 'super-secret-token' });
    await auth.requireAuth(accepted, reply2 as never);
    expect(reply2.code).not.toHaveBeenCalled();
    expect((accepted as unknown as { principal?: { kind: string } }).principal?.kind).toBe(
      'api-key',
    );
  });

  it('can be explicitly disabled for tests only', () => {
    expect(service({ disabled: true }).authenticate(request())).toEqual({
      id: 'dev',
      kind: 'anonymous',
    });
  });
});
