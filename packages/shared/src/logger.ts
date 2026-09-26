import { pino, type Logger } from 'pino';

const SECRET_KEY_PATTERN =
  /(password|passwd|token|secret|authorization|apikey|api_key|authme|cookie|session)/i;

export function redactSecrets<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redactSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}

export interface LoggerOptions {
  name: string;
  level?: string;
}

export function createLogger(opts: LoggerOptions): Logger {
  return pino({
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: opts.name },
    redact: {
      paths: [
        'password',
        '*.password',
        'token',
        '*.token',
        'secret',
        '*.secret',
        'authorization',
        '*.authorization',
        'authmePassword',
        '*.authmePassword',
        'apiKey',
        '*.apiKey',
      ],
      censor: '[redacted]',
    },
  });
}

export type { Logger };
