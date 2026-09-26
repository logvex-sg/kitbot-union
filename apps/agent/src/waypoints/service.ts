import type { Logger, WaypointType } from '@unionkitbot/shared';
import type { WaypointRow, WaypointRepository } from '@unionkitbot/database';
import type { AgentEventEmitter } from '../events.js';

export interface WaypointServiceOptions {
  botId: string;
  server: string;
  logger: Logger;
  events: AgentEventEmitter;
  repository: WaypointRepository;
}

export interface CreateWaypointInput {
  name: string;
  type: WaypointType;
  dimension: string;
  x: number;
  y: number;
  z: number;
  playerId?: string | null;
  metadata?: Record<string, unknown>;
}

export class WaypointService {
  private readonly options: WaypointServiceOptions;

  constructor(options: WaypointServiceOptions) {
    this.options = options;
  }

  async create(input: CreateWaypointInput): Promise<WaypointRow> {
    const waypoint = await this.options.repository.create({
      name: input.name,
      type: input.type,
      server: this.options.server,
      dimension: input.dimension,
      x: input.x,
      y: input.y,
      z: input.z,
      botId: this.options.botId,
      playerId: input.playerId ?? null,
      metadata: input.metadata ?? {},
    });
    this.options.events.emit(
      'bot:waypoint',
      `waypoint ${waypoint.type} created: ${waypoint.name}`,
      {
        id: waypoint.id,
        type: waypoint.type,
        name: waypoint.name,
        dimension: waypoint.dimension,
        x: waypoint.x,
        y: waypoint.y,
        z: waypoint.z,
      },
      { botId: this.options.botId },
    );
    return waypoint;
  }

  async list(
    filter: {
      type?: string;
      server?: string;
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<WaypointRow[]> {
    return this.options.repository.list({ server: this.options.server, ...filter });
  }

  async nearby(
    type: WaypointType,
    x: number,
    y: number,
    z: number,
    radius = 4,
  ): Promise<WaypointRow[]> {
    const all = await this.list({ type, limit: 500 });
    return all.filter(
      (w) =>
        Math.abs(w.x - x) <= radius && Math.abs(w.y - y) <= radius && Math.abs(w.z - z) <= radius,
    );
  }

  async update(id: string, patch: Partial<CreateWaypointInput>): Promise<WaypointRow | null> {
    return this.options.repository.update(id, patch as never);
  }

  async delete(id: string): Promise<boolean> {
    return this.options.repository.delete(id);
  }
}
