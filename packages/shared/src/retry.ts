import { TimeoutError } from './errors.js';

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  jitter?: boolean;
  maxAttempts?: number;
}

export function backoffDelay(attempt: number, opts: BackoffOptions, random = Math.random): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const raw = opts.baseDelayMs * Math.pow(2, safeAttempt - 1);
  const clamped = Math.min(raw, opts.maxDelayMs);
  if (!opts.jitter) return Math.round(clamped);
  const jitterSpan = Math.min(clamped * 0.25, 5000);
  const jittered = clamped - jitterSpan / 2 + random() * jitterSpan;
  // Jitter is applied around the delay but must still honour the configured ceiling.
  return Math.round(Math.min(Math.max(jittered, 0), opts.maxDelayMs));
}

export function shouldRetry(attempt: number, opts: BackoffOptions): boolean {
  if (opts.maxAttempts === undefined) return true;
  return attempt < opts.maxAttempts;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rejects if `promise` has not settled within `ms`. Used to bound operations that may
 * otherwise never settle (e.g. mineflayer's openContainer on an unreachable block).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface RetryOptions extends BackoffOptions {
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  signal?: AbortSignal;
}

export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (!shouldRetry(attempt, opts)) throw error;
      const delay = backoffDelay(attempt, opts);
      opts.onRetry?.(attempt, error, delay);
      await sleep(delay);
    }
  }
}
