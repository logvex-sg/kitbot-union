import { randomUUID } from 'node:crypto';
import { TypedEventBus, type AgentEvent, type AgentEventType } from '@unionkitbot/shared';

export class AgentEventEmitter {
  private readonly bus = new TypedEventBus();

  emit(
    type: AgentEventType,
    message: string,
    data: unknown = {},
    options: { botId?: string | null; severity?: AgentEvent['severity'] } = {},
  ): AgentEvent {
    const event: AgentEvent = {
      id: randomUUID(),
      type,
      botId: options.botId ?? null,
      at: new Date().toISOString(),
      severity: options.severity ?? 'info',
      message,
      data,
    };
    this.bus.emit(event);
    return event;
  }

  on(type: AgentEventType | '*', handler: (event: AgentEvent) => void): () => void {
    return this.bus.on(type, handler);
  }

  dispose(): void {
    this.bus.removeAll();
  }
}
