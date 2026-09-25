import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '@unionkitbot/shared';
import type { BotRegistry } from './registry.js';
import type { CommandRouter } from './commands.js';
import type { AgentEventEmitter } from './events.js';

export interface ControlServerOptions {
  logger: Logger;
  registry: BotRegistry;
  router: CommandRouter;
  events: AgentEventEmitter;
  port: number;
  host: string;
  secret: string;
}

interface ControlMessage {
  id?: string;
  command?: string;
  args?: string[];
  bot?: string;
  actor?: string;
  /** Which entry point issued the command; the agent labels its audit trail with it. */
  source?: string;
}

/**
 * Internal control socket for the API and Discord processes. It is bound to a private
 * address and requires the shared API secret, so command execution cannot be triggered by
 * an unauthenticated client. Live events are also fanned out to Redis for the API to relay.
 */
export class ControlServer {
  private readonly wss: WebSocketServer;
  private readonly options: ControlServerOptions;
  private readonly clients = new Set<WebSocket>();

  constructor(options: ControlServerOptions) {
    this.options = options;
    this.wss = new WebSocketServer({ port: options.port, host: options.host });

    this.wss.on('connection', (socket, request) => {
      const header = request.headers['x-api-key'];
      const token = Array.isArray(header) ? header[0] : header;
      if (!token || token !== options.secret) {
        socket.close(4401, 'unauthorized');
        options.logger.warn('rejected unauthenticated control connection');
        return;
      }
      this.clients.add(socket);
      socket.on('close', () => this.clients.delete(socket));
      socket.on('message', (raw) => {
        void this.handleMessage(socket, raw.toString());
      });
      socket.send(JSON.stringify({ type: 'hello', bots: options.registry.snapshots() }));
    });

    options.events.on('*', (event) => {
      this.broadcast({ type: 'event', event });
    });
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let parsed: ControlMessage;
    try {
      parsed = JSON.parse(raw) as ControlMessage;
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
      return;
    }
    if (!parsed.command) {
      socket.send(JSON.stringify({ type: 'error', message: 'command is required' }));
      return;
    }
    const result = await this.options.router.execute({
      command: parsed.command,
      args: parsed.args ?? [],
      ...(parsed.bot !== undefined ? { bot: parsed.bot } : {}),
      source: parsed.source === 'discord' ? 'discord' : 'api',
      actor: parsed.actor ?? 'control-socket',
    });
    socket.send(JSON.stringify({ id: parsed.id ?? null, type: 'result', ...result }));
  }

  private broadcast(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch {
          this.clients.delete(client);
        }
      }
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.close(1001, 'shutting down');
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
