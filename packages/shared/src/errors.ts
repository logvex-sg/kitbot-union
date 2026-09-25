export class UnionKitError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }
}
export class ValidationError extends UnionKitError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('VALIDATION_ERROR', message, detail);
  }
}
export class NavigationError extends UnionKitError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('NAVIGATION_ERROR', message, detail);
  }
}
export class DeliveryError extends UnionKitError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('DELIVERY_ERROR', message, detail);
  }
}
export class NotConnectedError extends UnionKitError {
  constructor(message = 'Bot is not connected to a Minecraft server') {
    super('NOT_CONNECTED', message);
  }
}
export class TaskCancelledError extends UnionKitError {
  constructor(message = 'Task was cancelled') {
    super('TASK_CANCELLED', message);
  }
}
export class TimeoutError extends UnionKitError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('TIMEOUT', message, detail);
  }
}
