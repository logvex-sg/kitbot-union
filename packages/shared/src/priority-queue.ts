import { randomUUID } from 'node:crypto';
import {
  PRIORITY_WEIGHT,
  type PriorityTask,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from './types.js';
import { CancellationError, CancelToken } from './cancellation.js';

export type TaskHandler = (task: PriorityTask, ctx: TaskExecutionContext) => Promise<unknown>;

export interface TaskExecutionContext {
  token: CancelToken;
  setResumeState: (patch: Record<string, unknown>) => void;
  signal: AbortSignal;
}

export interface CreateTaskInput<T = unknown> {
  botId: string;
  type: TaskType;
  priority: TaskPriority;
  payload?: T;
  maxAttempts?: number;
  id?: string;
}

export interface SchedulerHooks {
  onTaskUpdated?: (task: PriorityTask) => void;
  onTaskDropped?: (task: PriorityTask, reason: string) => void;
}

/**
 * Priority task queue with pause/resume/cancel support.
 * Priority is strict (CRITICAL > HIGH > NORMAL > LOW) and FIFO within a band.
 */
export class PriorityTaskQueue {
  private readonly tasks = new Map<string, PriorityTask>();
  private readonly handlers = new Map<TaskType, TaskHandler>();
  private readonly running = new Map<string, { token: CancelToken; controller: AbortController }>();
  private paused = false;
  private draining = false;
  private drainScheduled = false;
  private readonly maxConcurrent: number;
  private readonly hooks: SchedulerHooks;

  constructor(maxConcurrent = 1, hooks: SchedulerHooks = {}) {
    this.maxConcurrent = maxConcurrent;
    this.hooks = hooks;
  }

  registerHandler(type: TaskType, handler: TaskHandler): void {
    this.handlers.set(type, handler);
  }

  enqueue<T>(input: CreateTaskInput<T>): PriorityTask<T> {
    const now = Date.now();
    const task: PriorityTask<T> = {
      id: input.id ?? randomUUID(),
      botId: input.botId,
      type: input.type,
      priority: input.priority,
      status: 'PENDING',
      payload: input.payload ?? ({} as T),
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      resumeState: {},
    };
    this.tasks.set(task.id, task as PriorityTask);
    this.hooks.onTaskUpdated?.(task as PriorityTask);
    this.scheduleDrain();
    return task;
  }

  /** Re-registers a persisted task in PAUSED state so it resumes deliberately. */
  hydrate(task: PriorityTask): void {
    this.tasks.set(task.id, { ...task, status: 'PAUSED' });
    this.hooks.onTaskUpdated?.(this.tasks.get(task.id)!);
  }

  list(): PriorityTask[] {
    return [...this.tasks.values()].sort((a, b) => this.compare(a, b));
  }

  get(id: string): PriorityTask | undefined {
    return this.tasks.get(id);
  }

  peekNext(): PriorityTask | null {
    let best: PriorityTask | null = null;
    for (const task of this.tasks.values()) {
      if (task.status !== 'PENDING') continue;
      if (!best || this.compare(task, best) < 0) best = task;
    }
    return best;
  }

  private compare(a: PriorityTask, b: PriorityTask): number {
    const byPriority = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    if (byPriority !== 0) return byPriority;
    return a.createdAt - b.createdAt;
  }

  pause(): void {
    this.paused = true;
    for (const task of this.tasks.values()) {
      if (task.status === 'PENDING') {
        task.status = 'PAUSED';
        task.updatedAt = Date.now();
        this.hooks.onTaskUpdated?.(task);
      }
    }
  }

  resume(): void {
    this.paused = false;
    for (const task of this.tasks.values()) {
      if (task.status === 'PAUSED') {
        task.status = 'PENDING';
        task.updatedAt = Date.now();
        this.hooks.onTaskUpdated?.(task);
      }
    }
    this.scheduleDrain();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  pauseTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status !== 'PENDING' && task.status !== 'RUNNING') return false;
    if (task.status === 'RUNNING') this.running.get(id)?.token.cancel();
    task.status = 'PAUSED';
    task.updatedAt = Date.now();
    this.hooks.onTaskUpdated?.(task);
    return true;
  }

  resumeTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'PAUSED') return false;
    task.status = 'PENDING';
    task.updatedAt = Date.now();
    this.hooks.onTaskUpdated?.(task);
    this.scheduleDrain();
    return true;
  }

  cancel(id: string, reason = 'cancelled by request'): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED' || task.status === 'FAILED')
      return false;
    this.running.get(id)?.token.cancel();
    task.status = 'CANCELLED';
    task.error = reason;
    task.updatedAt = Date.now();
    task.finishedAt = Date.now();
    this.hooks.onTaskUpdated?.(task);
    this.running.delete(id);
    return true;
  }

  cancelAll(reason = 'shutdown'): void {
    for (const task of [...this.tasks.values()]) this.cancel(task.id, reason);
  }

  private setStatus(task: PriorityTask, status: TaskStatus): void {
    task.status = status;
    task.updatedAt = Date.now();
    this.hooks.onTaskUpdated?.(task);
  }

  /**
   * Coalesces drain requests onto the next tick. Without this, the task enqueued first in a
   * synchronous burst would start running before higher-priority tasks enqueued right after it.
   */
  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining || this.paused) return;
    this.draining = true;
    try {
      while (!this.paused && this.running.size < this.maxConcurrent) {
        const task = this.peekNext();
        if (!task) break;
        void this.execute(task);
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(task: PriorityTask): Promise<void> {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      task.error = `No handler registered for task type ${task.type}`;
      task.finishedAt = Date.now();
      this.setStatus(task, 'FAILED');
      this.hooks.onTaskDropped?.(task, task.error);
      return;
    }
    const token = new CancelToken();
    const controller = new AbortController();
    token.onCancel(() => controller.abort());
    this.running.set(task.id, { token, controller });
    task.attempts += 1;
    task.startedAt = task.startedAt ?? Date.now();
    this.setStatus(task, 'RUNNING');
    try {
      const result = await handler(task, {
        token,
        signal: controller.signal,
        setResumeState: (patch) => {
          task.resumeState = { ...task.resumeState, ...patch };
        },
      });
      if (task.status === 'CANCELLED' || task.status === 'PAUSED') return;
      task.result = result;
      task.error = null;
      task.finishedAt = Date.now();
      this.setStatus(task, 'COMPLETED');
    } catch (error) {
      if (error instanceof CancellationError || task.status === 'CANCELLED') {
        if (task.status !== 'CANCELLED') this.setStatus(task, 'PAUSED');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      task.error = message;
      if (task.attempts < task.maxAttempts) {
        this.setStatus(task, 'PENDING');
      } else {
        task.finishedAt = Date.now();
        this.setStatus(task, 'FAILED');
        this.hooks.onTaskDropped?.(task, message);
      }
    } finally {
      this.running.delete(task.id);
      this.scheduleDrain();
    }
  }

  async idleWhenDrained(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.running.size === 0 && this.peekNext() === null) return;
      if (Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
