import { describe, expect, it } from 'vitest';
import { PRIORITY_WEIGHT, PriorityTaskQueue, type PriorityTask } from '@unionkitbot/shared';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('priority task scheduler', () => {
  it('orders strictly by priority weight then FIFO', () => {
    const queue = new PriorityTaskQueue(1);
    queue.enqueue({ botId: 'b', type: 'STATISTICS', priority: 'LOW', payload: { n: 1 } });
    queue.enqueue({ botId: 'b', type: 'DELIVERY', priority: 'NORMAL', payload: { n: 2 } });
    queue.enqueue({ botId: 'b', type: 'RECONNECT', priority: 'CRITICAL', payload: { n: 3 } });
    queue.enqueue({ botId: 'b', type: 'FOLLOW', priority: 'HIGH', payload: { n: 4 } });
    queue.enqueue({ botId: 'b', type: 'DELIVERY', priority: 'NORMAL', payload: { n: 5 } });

    const order = queue.list().map((task) => task.priority);
    expect(order).toEqual(['CRITICAL', 'HIGH', 'NORMAL', 'NORMAL', 'LOW']);
    expect(PRIORITY_WEIGHT.CRITICAL).toBeLessThan(PRIORITY_WEIGHT.HIGH);
    expect(PRIORITY_WEIGHT.HIGH).toBeLessThan(PRIORITY_WEIGHT.NORMAL);
    expect(PRIORITY_WEIGHT.NORMAL).toBeLessThan(PRIORITY_WEIGHT.LOW);
  });

  it('executes the highest priority task first', async () => {
    const queue = new PriorityTaskQueue(1);
    const executed: string[] = [];
    queue.registerHandler('STATISTICS', async () => {
      executed.push('low');
    });
    queue.registerHandler('RECONNECT', async () => {
      executed.push('critical');
    });
    queue.registerHandler('DELIVERY', async () => {
      executed.push('normal');
    });

    queue.enqueue({ botId: 'b', type: 'STATISTICS', priority: 'LOW' });
    queue.enqueue({ botId: 'b', type: 'DELIVERY', priority: 'NORMAL' });
    queue.enqueue({ botId: 'b', type: 'RECONNECT', priority: 'CRITICAL' });

    await queue.idleWhenDrained(3000);
    expect(executed[0]).toBe('critical');
  });

  it('retries a failing handler up to maxAttempts then drops it', async () => {
    const queue = new PriorityTaskQueue(1);
    const dropped: string[] = [];
    let attempts = 0;
    queue.registerHandler('DELIVERY', async () => {
      attempts += 1;
      throw new Error('boom');
    });
    const task = queue.enqueue({
      botId: 'b',
      type: 'DELIVERY',
      priority: 'NORMAL',
      maxAttempts: 3,
    });
    await queue.idleWhenDrained(4000);
    expect(attempts).toBe(3);
    expect(queue.get(task.id)?.status).toBe('FAILED');
    expect(queue.get(task.id)?.error).toContain('boom');
    expect(dropped).toEqual([]);
  });

  it('cancels a pending task and rejects re-cancellation', async () => {
    const queue = new PriorityTaskQueue(1);
    queue.registerHandler('NAVIGATE', async () => wait(200));
    const task = queue.enqueue({ botId: 'b', type: 'NAVIGATE', priority: 'NORMAL' });
    expect(queue.cancel(task.id, 'test')).toBe(true);
    expect(queue.cancel(task.id, 'test')).toBe(false);
    expect(queue.get(task.id)?.status).toBe('CANCELLED');
  });

  it('pauses and resumes paused work', async () => {
    const queue = new PriorityTaskQueue(1);
    const ran: string[] = [];
    queue.registerHandler('STATISTICS', async () => {
      ran.push('ran');
    });

    const second = queue.enqueue({ botId: 'b', type: 'STATISTICS', priority: 'LOW' });
    expect(queue.pauseTask(second.id)).toBe(true);
    expect(queue.get(second.id)?.status).toBe('PAUSED');
    await wait(40);
    expect(ran).toEqual([]);
    expect(queue.resumeTask(second.id)).toBe(true);
    await queue.idleWhenDrained(3000);
    expect(queue.get(second.id)?.status).toBe('COMPLETED');
    expect(ran).toEqual(['ran']);
  });

  it('hydrates persisted tasks as paused and resumes them explicitly', async () => {
    const queue = new PriorityTaskQueue(1);
    const ran: string[] = [];
    queue.registerHandler('DELIVERY', async () => {
      ran.push('resumed');
    });
    const persisted: PriorityTask = {
      id: '11111111-1111-1111-1111-111111111111',
      botId: 'b',
      type: 'DELIVERY',
      priority: 'NORMAL',
      status: 'RUNNING',
      payload: { recipient: 'steve', kitIds: ['starter'] },
      attempts: 1,
      maxAttempts: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      resumeState: { deliveryStep: 'DELIVER' },
    };
    queue.hydrate(persisted);
    expect(queue.get(persisted.id)?.status).toBe('PAUSED');
    await wait(40);
    expect(ran).toEqual([]);
    queue.resume();
    await queue.idleWhenDrained(3000);
    expect(ran).toEqual(['resumed']);
  });

  it('propagates an AbortSignal when a task is cancelled', async () => {
    const queue = new PriorityTaskQueue(1);
    let aborted = 0;
    queue.registerHandler('NAVIGATE', async (_task, ctx) => {
      ctx.signal.addEventListener('abort', () => {
        aborted += 1;
      });
      await wait(400);
    });
    const task = queue.enqueue({ botId: 'b', type: 'NAVIGATE', priority: 'NORMAL' });
    await wait(50);
    queue.cancel(task.id, 'stop');
    await wait(50);
    expect(aborted).toBe(1);
  });
});
