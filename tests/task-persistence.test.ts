/**
 * Regression coverage for defects found while smoke-testing the live deployment:
 *
 * 1. Task rows could be stranded in RUNNING. onTaskUpdated fired a persistence call for every
 *    transition and those upserts ran concurrently, so the RUNNING write could land after the
 *    terminal COMPLETED write. The agent reported IDLE while Postgres said RUNNING.
 * 2. A STORAGE_SCAN task without an `origin` payload crashed with a raw TypeError
 *    ("Cannot read properties of undefined (reading 'x')") instead of scanning at the bot.
 * 3. Task writes were fire-and-forget, so a shutdown could drop the terminal transition and
 *    the next boot restored a finished task as RUNNING. WriteBehind.close() now drains.
 */
import { describe, expect, it } from 'vitest';
import { isVec3, PriorityTaskQueue, WriteBehind, type PriorityTask } from '@unionkitbot/shared';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Snapshot {
  id: string;
  status: string;
}

/** In-memory stand-in for TaskRepository.upsert, recording write order and concurrency. */
function makeWriter(writeDelayMs = 0) {
  const stored = new Map<string, string>();
  const writes: string[] = [];
  let concurrent = 0;
  let peakConcurrency = 0;
  const writer = new WriteBehind<Snapshot>((snapshot) => snapshot.id, async (snapshot) => {
    concurrent += 1;
    peakConcurrency = Math.max(peakConcurrency, concurrent);
    try {
      if (writeDelayMs > 0) await wait(writeDelayMs);
      stored.set(snapshot.id, snapshot.status);
      writes.push(`${snapshot.id}:${snapshot.status}`);
    } finally {
      concurrent -= 1;
    }
  });
  return { writer, stored, writes, peakConcurrency: () => peakConcurrency };
}

describe('isVec3 guard', () => {
  it('accepts a well-formed coordinate triple', () => {
    expect(isVec3({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(isVec3({ x: 0, y: -60.5, z: 0 })).toBe(true);
  });

  it('rejects missing, partial, non-numeric and non-finite coordinates', () => {
    expect(isVec3(undefined)).toBe(false);
    expect(isVec3(null)).toBe(false);
    expect(isVec3('1,2,3')).toBe(false);
    expect(isVec3({})).toBe(false);
    expect(isVec3({ x: 1, y: 2 })).toBe(false);
    expect(isVec3({ x: 1, y: 2, z: '3' })).toBe(false);
    expect(isVec3({ x: Number.NaN, y: 2, z: 3 })).toBe(false);
    expect(isVec3({ x: Number.POSITIVE_INFINITY, y: 2, z: 3 })).toBe(false);
  });
});

describe('task state write-behind', () => {
  it('never lets an earlier status overwrite the terminal one', async () => {
    const { writer, stored } = makeWriter(30);
    writer.save({ id: 't1', status: 'PENDING' });
    writer.save({ id: 't1', status: 'RUNNING' });
    writer.save({ id: 't1', status: 'COMPLETED' });
    await writer.close();

    expect(stored.get('t1')).toBe('COMPLETED');
  });

  it('coalesces rapid transitions into at most two writes', async () => {
    const { writer, writes } = makeWriter(20);
    writer.save({ id: 't1', status: 'PENDING' });
    writer.save({ id: 't1', status: 'RUNNING' });
    writer.save({ id: 't1', status: 'COMPLETED' });
    await writer.close();

    expect(writes.length).toBeLessThanOrEqual(2);
    expect(writes.at(-1)).toBe('t1:COMPLETED');
  });

  it('writes distinct task ids independently', async () => {
    const { writer, stored } = makeWriter();
    writer.save({ id: 'a', status: 'COMPLETED' });
    writer.save({ id: 'b', status: 'FAILED' });
    await writer.close();

    expect(stored.get('a')).toBe('COMPLETED');
    expect(stored.get('b')).toBe('FAILED');
  });

  it('drains on close so a shutdown cannot lose the terminal status', async () => {
    const { writer, stored } = makeWriter(10);
    writer.save({ id: 't1', status: 'CANCELLED' });
    // Close straight away: a fire-and-forget write would still be in flight here.
    await writer.close();

    expect(writer.pendingCount).toBe(0);
    expect(stored.get('t1')).toBe('CANCELLED');
  });

  it('flushes without closing, so stop/restart keeps persisting', async () => {
    const { writer, stored } = makeWriter();
    writer.save({ id: 't1', status: 'CANCELLED' });
    await writer.flush();
    expect(stored.get('t1')).toBe('CANCELLED');

    writer.save({ id: 't1', status: 'RUNNING' });
    await writer.flush();
    expect(stored.get('t1')).toBe('RUNNING');
  });

  it('does not run two writes for the same id concurrently', async () => {
    const { writer, peakConcurrency } = makeWriter(15);
    writer.save({ id: 't1', status: 'PENDING' });
    await wait(5);
    writer.save({ id: 't1', status: 'RUNNING' });
    await writer.close();

    expect(peakConcurrency()).toBe(1);
  });

  it('survives a storage error and still writes later snapshots', async () => {
    const stored = new Map<string, string>();
    let first = true;
    const writer = new WriteBehind<Snapshot>((snapshot) => snapshot.id, async (snapshot) => {
      if (first) {
        first = false;
        throw new Error('storage unavailable');
      }
      stored.set(snapshot.id, snapshot.status);
    });

    writer.save({ id: 't1', status: 'FAILED' });
    await writer.flush();
    writer.save({ id: 't2', status: 'COMPLETED' });
    await writer.close();

    expect(stored.get('t2')).toBe('COMPLETED');
  });

  it('ignores snapshots saved after close', async () => {
    const { writer, stored } = makeWriter();
    await writer.close();
    writer.save({ id: 't1', status: 'RUNNING' });
    await writer.flush();

    expect(stored.has('t1')).toBe(false);
  });
});

describe('failing task reaches a terminal state', () => {
  it('marks a task FAILED, never leaving it RUNNING, after maxAttempts', async () => {
    const queue = new PriorityTaskQueue(1);
    queue.registerHandler('STORAGE_SCAN', async () => {
      throw new Error("Cannot read properties of undefined (reading 'x')");
    });
    const task = queue.enqueue({
      botId: 'b',
      type: 'STORAGE_SCAN',
      priority: 'NORMAL',
      payload: {},
      maxAttempts: 2,
    });

    await queue.idleWhenDrained(4000);
    await wait(50);

    const settled = queue.get(task.id) as PriorityTask;
    expect(settled.status).toBe('FAILED');
    expect(settled.status).not.toBe('RUNNING');
  });
});
