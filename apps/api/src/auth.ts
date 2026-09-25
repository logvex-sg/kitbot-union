import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '@unionkitbot/shared';

export interface AuthPrincipal {
  id: string;
  kind: 'api-key' | 'discord' | 'anonymous';
}

export interface AuthOptions {
  apiSecret: string;
  allowedDiscordUsers: string[];
  logger: Logger;
  /** Disables auth for local development only; never enabled in production. */
  disabled?: boolean;
}

/** Constant-time comparison so token checks do not leak length/prefix information. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthService {
  constructor(private readonly options: AuthOptions) {}

  /** Extracts the bearer token from either Authorization or x-api-key. */
  private extractToken(request: FastifyRequest): string | null {
    const header = request.headers['authorization'];
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      return header.slice(7).trim();
    }
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey;
    if (Array.isArray(apiKey) && apiKey[0]) return apiKey[0];
    return null;
  }

  authenticate(request: FastifyRequest): AuthPrincipal | null {
    if (this.options.disabled) return { id: 'dev', kind: 'anonymous' };
    const token = this.extractToken(request);
    if (!token) return null;
    if (safeEqual(token, this.options.apiSecret)) return { id: 'api', kind: 'api-key' };
    if (this.options.allowedDiscordUsers.includes(token)) {
      return { id: token, kind: 'discord' };
    }
    this.options.logger.warn({ path: request.url }, 'rejected unauthenticated request');
    return null;
  }

  authenticateToken(token: string | null | undefined): AuthPrincipal | null {
    if (this.options.disabled) return { id: 'dev', kind: 'anonymous' };
    if (!token) return null;
    if (safeEqual(token, this.options.apiSecret)) return { id: 'api', kind: 'api-key' };
    if (this.options.allowedDiscordUsers.includes(token)) return { id: token, kind: 'discord' };
    return null;
  }

  /** Fastify preHandler that rejects unauthenticated callers with 401. */
  requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const principal = this.authenticate(request);
    if (!principal) {
      await reply
        .code(401)
        .send({ error: 'unauthorized', message: 'valid API credentials required' });
      return;
    }
    (request as FastifyRequest & { principal?: AuthPrincipal }).principal = principal;
  };
}
