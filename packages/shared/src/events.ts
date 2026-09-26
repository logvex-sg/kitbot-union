import { EventEmitter } from 'node:events';

export const AGENT_EVENT_TYPES = [
  'bot:state',
  'bot:connected',
  'bot:disconnected',
  'bot:reconnecting',
  'bot:spawned',
  'bot:heartbeat',
  'bot:death',
  'bot:chat',
  'bot:tpa',
  'bot:task',
  'bot:delivery',
  'bot:storage-scan',
  'bot:waypoint',
  'bot:error',
  'bot:log',
  'bot:inventory',
  'system:event',
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface AgentEvent<T = unknown> {
  id: string;
  type: AgentEventType;
  botId: string | null;
  at: string;
  severity: 'info' | 'warn' | 'error' | 'critical';
  message: string;
  data: T;
}

export class TypedEventBus {
  private readonly emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(200);
  }
  emit(event: AgentEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit('*', event);
  }
  on(type: AgentEventType | '*', handler: (event: AgentEvent) => void): () => void {
    this.emitter.on(type, handler);
    return () => this.emitter.off(type, handler);
  }
  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}
