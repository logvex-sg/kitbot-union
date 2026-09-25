export class CancellationError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

export class CancelToken {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();
  get isCancelled(): boolean {
    return this.cancelled;
  }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  onCancel(listener: () => void): () => void {
    if (this.cancelled) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  throwIfCancelled(): void {
    if (this.cancelled) throw new CancellationError();
  }
}

export async function withCancellation<T>(
  promise: Promise<T>,
  token: CancelToken,
  timeoutMs?: number,
): Promise<T> {
  if (token.isCancelled) throw new CancellationError();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      settled = true;
      if (timer) clearTimeout(timer);
    };
    const unsubscribe = token.onCancel(() => {
      if (settled) return;
      finish();
      unsubscribe();
      reject(new CancellationError());
    });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        finish();
        unsubscribe();
        reject(new Error(`Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    promise.then(
      (value) => {
        if (settled) return;
        finish();
        unsubscribe();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        finish();
        unsubscribe();
        reject(error);
      },
    );
  });
}
