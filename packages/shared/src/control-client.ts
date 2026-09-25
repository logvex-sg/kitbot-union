import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Logger } from './logger.js';
import type { AgentEvent } from './events.js';

export interface CommandResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

export interface AgentClientOptions {
  url: string;
  secret: string;
  logger: Logger;
  onEvent?: (event: AgentEvent) => void;
  /** Audit label applied to every command sent over this client, e.g. 'discord' or 'api'. */
  source?: string;
}

/**
 * Client for the agent's private control socket. It is the only path by which the API can
 * trigger Minecraft actions, so all mutations funnel through one authenticated channel.
 */
export class AgentClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, (result: CommandResult) => void>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: AgentClientOptions) {}

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.closed || this.socket) return;
    const socket = new WebSocket(this.options.url, {
      headers: { 'x-api-key': this.options.secret },
    });
    this.socket = socket;

    socket.on('open', () => {
      this.options.logger.info('connected to agent control socket');
    });

    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as {
          type?: string;
          event?: AgentEvent;
          id?: string | null;
          ok?: boolean;
          message?: string;
          data?: unknown;
        };
        if (payload.type === 'event' && payload.event) {
          this.options.onEvent?.(payload.event);
          return;
        }
        if (payload.type === 'result' && payload.id) {
          const resolve = this.pending.get(payload.id);
          if (resolve) {
            this.pending.delete(payload.id);
            resolve({
              ok: payload.ok ?? false,
              message: payload.message ?? '',
              data: payload.data,
            });
          }
        }
      } catch (error) {
        this.options.logger.debug({ err: error }, 'bad control message');
      }
    });

    socket.on('close', () => {
      this.socket = null;
      for (const [id, resolve] of this.pending) {
        this.pending.delete(id);
        resolve({ ok: false, message: 'agent control socket closed' });
      }
      if (!this.closed) this.scheduleReconnect();
    });

    socket.on('error', (error) => {
      this.options.logger.debug({ err: error }, 'agent control socket error');
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2_000);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  async send(
    command: string,
    args: string[] = [],
    bot?: string,
    actor = 'api',
  ): Promise<CommandResult> {
    if (!this.connected || !this.socket) {
      return { ok: false, message: 'agent is not reachable' };
    }
    const id = randomUUID();
    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, message: `agent did not respond within 30s for command ${command}` });
      }, 30_000);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.socket!.send(
        JSON.stringify({
          id,
          command,
          args,
          ...(bot !== undefined ? { bot } : {}),
          ...(this.options.source !== undefined ? { source: this.options.source } : {}),
          actor,
        }),
      );
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'api shutting down');
    this.socket = null;
  }
}
