import type { Logger } from './logger.js';

export interface WriteBehindOptions {
  /**
   * Max ids held in memory before snapshots are written through directly. Purely a memory
   * bound: real workloads keep one or two entries pending per bot.
   */
  maxPending?: number;
  logger?: Logger;
}

interface Pending {
  value: unknown;
  dirty: boolean;
  promise: Promise<void>;
}

/**
 * Write-behind persister for mutable records keyed by id.
 *
 * Two properties the naive `void repo.upsert(x)` call does not have:
 *
 * - Ordering. Writes for one id are chained, so a slow PENDING write can never land after
 *   the terminal COMPLETED/FAILED write and resurrect a finished record.
 * - Coalescing. Many transitions collapse into one write. A task going
 *   PENDING -> RUNNING -> COMPLETED while a write is in flight costs two writes, not three,
 *   because only the latest snapshot of a batch is sent.
 *
 * Because coalescing sends only the latest snapshot, a snapshot can sit in memory while a
 * write is in flight, so `close()` must be awaited before the process exits.
 */
export class WriteBehind<T> {
  private readonly pending = new Map<string, Pending>();
  private readonly maxPending: number;
  private readonly logger?: Logger;
  private closed = false;

  constructor(
    private readonly idOf: (value: T) => string,
    private readonly write: (value: T) => Promise<void>,
    options: WriteBehindOptions = {},
  ) {
    this.maxPending = options.maxPending ?? 5000;
    this.logger = options.logger;
  }

  /** Records the latest snapshot for an id and schedules it to be written. */
  save(value: T): void {
    if (this.closed) return;
    const id = this.idOf(value);
    const existing = this.pending.get(id);
    if (existing) {
      existing.value = value;
      existing.dirty = true;
      return;
    }
    if (this.pending.size >= this.maxPending) {
      // Memory bound reached. Write through instead of holding the snapshot, so nothing is
      // lost; this only triggers if storage is far slower than the transition rate.
      this.logger?.warn({ id, maxPending: this.maxPending }, 'write-behind at capacity');
      void this.write(value).catch((error: unknown) =>
        this.logger?.debug({ err: error, id }, 'write-behind persist failed'),
      );
      return;
    }
    this.pending.set(id, { value, dirty: true, promise: Promise.resolve() });
    setImmediate(() => void this.flush());
  }

  /** Writes every pending snapshot and resolves once all writes have settled. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      const entries = [...this.pending.entries()];
      for (const [, entry] of entries) {
        const snapshot = entry.value;
        entry.promise = entry.promise.then(async () => {
          try {
            await this.write(snapshot as T);
          } catch (error: unknown) {
            this.logger?.debug({ err: error }, 'write-behind persist failed');
          }
        });
        entry.dirty = false;
      }
      // Settle the whole round before re-checking, so transitions raised during the round
      // coalesce into the next round instead of extending this one.
      await Promise.all(entries.map(([, entry]) => entry.promise));
      for (const [id, entry] of entries) {
        if (!entry.dirty && this.pending.get(id) === entry) this.pending.delete(id);
      }
    }
  }

  /** Stops accepting snapshots and drains. Await this before exiting. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
