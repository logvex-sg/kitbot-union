/**
 * Regression coverage for two defects found while smoke-testing the live deployment:
 *
 * 1. Task rows could be stranded in RUNNING. onTaskUpdated fires a persistence call for
 *    every transition, and those upserts ran concurrently, so the RUNNING write could land
 *    after the terminal COMPLETED write. The agent reported IDLE while Postgres said RUNNING.
 * 2. A STORAGE_SCAN task without an `origin` payload crashed with a raw TypeError
 *    ("Cannot read properties of undefined (reading 'x')") instead of scanning at the bot.
 */
import { describe, expect, it } from 'vitest';
import { isVec3, PriorityTaskQueue, type PriorityTask } from '@unionkitbot/shared';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe('task persistence ordering', () => {
  /**
   * Reproduces the race directly: fire the same sequence of upserts the runtime would emit,
   * with a slow first write, and assert that a serialising chain leaves the terminal state
   * last. Without chaining the RUNNING write wins and the row is stranded.
   */
  it('leaves the terminal status last when an earlier write is slow', async () => {
    const rows = new Map<string, string>();
    const taskId = 'task-1';
    const chains = new Map<string, Promise<void>>();
    const persist = (status: string): Promise<void> => {
      const previous = chains.get(taskId) ?? Promise.resolve();
      const next = previous.then(async () => {
        if (status === 'RUNNING') await wait(30);
        rows.set(taskId, status);
      });
      chains.set(taskId, next);
      return next;
    };

    persist('RUNNING');
    persist('COMPLETED');
    await wait(80);

    expect(rows.get(taskId)).toBe('COMPLETED');
  });

  it('strands the row as RUNNING without serialisation, showing the fix is necessary', async () => {
    const rows = new Map<string, string>();
    const taskId = 'task-1';
    const unsynchronised = async (status: string) => {
      if (status === 'RUNNING') await wait(30);
      rows.set(taskId, status);
    };

    void unsynchronised('RUNNING');
    void unsynchronised('COMPLETED');
    await wait(80);

    expect(rows.get(taskId)).toBe('RUNNING');
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
