import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AgentEvent, Logger } from '@unionkitbot/shared';
import type { RedisState } from '@unionkitbot/database';
import type { AuthService } from './auth.js';
import { REDIS_CHANNELS } from '@unionkitbot/database';

export interface EventHubOptions {
  logger: Logger;
  redis: RedisState;
  auth: AuthService;
  path: string;
}

type SocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, handler: (...args: never[]) => void) => void;
};

type WsHandler = (socket: never, request: never) => void;

/**
 * Live event fan-out. The agent publishes to Redis, and every API instance relays to its
 * connected UI clients, so the dashboard stays accurate across restarts and scale-out.
 * Clients must present a valid token before they receive any event stream.
 */
export class EventHub {
  private readonly clients = new Map<string, SocketLike>();
  private readonly buffer: AgentEvent[] = [];
  private readonly subscriber;
  private readonly options: EventHubOptions;
  /** Ids already broadcast, so an event arriving over both the Redis and control-socket
   * paths is shown once. Bounded because Redis is the cross-instance transport. */
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(options: EventHubOptions) {
    this.options = options;
    this.subscriber = options.redis.client.duplicate();
    void this.subscriber.subscribe(REDIS_CHANNELS.events);
    this.subscriber.on('message', (_channel: string, payload: string) => {
      try {
        const event = JSON.parse(payload) as AgentEvent;
        this.broadcast(event);
      } catch (error) {
        this.options.logger.debug({ err: error }, 'bad redis event payload');
      }
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  recentEvents(limit = 200): AgentEvent[] {
    return this.buffer.slice(-limit);
  }

  /**
   * Accepts an event directly (used by tests and by the agent client fallback path).
   * The same event also arrives over Redis, so duplicates are dropped by id.
   */
  ingest(event: AgentEvent): void {
    this.broadcast(event);
  }

  private alreadySeen(id: string): boolean {
    if (this.seenIds.has(id)) return true;
    this.seenIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 2000) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    return false;
  }

  private broadcast(event: AgentEvent): void {
    if (this.alreadySeen(event.id)) return;
    this.buffer.push(event);
    if (this.buffer.length > 1000) this.buffer.shift();
    const message = JSON.stringify({ type: 'event', event });
    for (const [id, socket] of this.clients) {
      try {
        socket.send(message);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  /**
   * Registers the websocket route. The token is read from the query string because
   * browser WebSocket clients cannot set arbitrary headers.
   */
  register(app: FastifyInstance): void {
    const handler = (socket: SocketLike, request: { query: Record<string, unknown> }): void => {
      const query = request.query ?? {};
      const token =
        typeof query['token'] === 'string'
          ? query['token']
          : typeof query['apiKey'] === 'string'
            ? query['apiKey']
            : undefined;
      const principal = this.options.auth.authenticateToken(token);
      if (!principal) {
        socket.close(4401, 'unauthorized');
        return;
      }

      const id = randomUUID();
      this.clients.set(id, socket);
      void this.options.redis.trackWsClient(id).catch(() => undefined);

      socket.send(JSON.stringify({ type: 'hello', recent: this.recentEvents(50) }));

      socket.on('close', () => {
        this.clients.delete(id);
        void this.options.redis.untrackWsClient(id).catch(() => undefined);
      });
      socket.on('error', () => {
        this.clients.delete(id);
      });
    };
    (app.get as unknown as (path: string, opts: unknown, h: WsHandler) => void)(
      this.options.path,
      { websocket: true },
      handler as unknown as WsHandler,
    );
  }

  async close(): Promise<void> {
    for (const socket of this.clients.values()) {
      try {
        socket.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    await this.subscriber.quit().catch(() => undefined);
  }
}
