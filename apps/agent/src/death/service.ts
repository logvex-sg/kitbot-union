import type { Logger, Vec3 } from '@unionkitbot/shared';
import type { EventRepository } from '@unionkitbot/database';
import type { AgentEventEmitter } from '../events.js';
import type { WaypointService } from '../waypoints/service.js';

export interface DeathServiceOptions {
  botId: string;
  username: string;
  logger: Logger;
  events: AgentEventEmitter;
  eventsRepository: EventRepository;
  waypoints: WaypointService;
  getDimension: () => string;
  getActiveTaskId: () => string | null;
}

export interface DeathRecord {
  deathEventId: string;
  waypointId: string | null;
  position: Vec3 | null;
  dimension: string;
  activeTaskId: string | null;
  taskToRestore: string | null;
  at: string;
}

/**
 * Handles legitimate deaths only - the bot never kills itself. Records the event,
 * the coordinates, the active task and creates a DEATH waypoint for recovery.
 */
export class DeathService {
  private readonly options: DeathServiceOptions;
  private lastRecord: DeathRecord | null = null;

  constructor(options: DeathServiceOptions) {
    this.options = options;
  }

  get lastDeath(): DeathRecord | null {
    return this.lastRecord;
  }

  async recordDeath(position: Vec3 | null, cause: string | null): Promise<DeathRecord> {
    const dimension = this.options.getDimension();
    const activeTaskId = this.options.getActiveTaskId();

    let waypointId: string | null = null;
    if (position) {
      try {
        const waypoint = await this.options.waypoints.create({
          name: `death ${new Date().toISOString()}`,
          type: 'DEATH',
          dimension,
          x: position.x,
          y: position.y,
          z: position.z,
          metadata: { cause, activeTaskId },
        });
        waypointId = waypoint.id;
      } catch (error) {
        this.options.logger.error({ err: error }, 'failed to create death waypoint');
      }
    }

    const deathEventId = await this.options.eventsRepository.recordDeath({
      botId: this.options.botId,
      dimension,
      x: position?.x ?? null,
      y: position?.y ?? null,
      z: position?.z ?? null,
      cause,
      activeTaskId,
      waypointId,
      metadata: { username: this.options.username },
    });

    const record: DeathRecord = {
      deathEventId,
      waypointId,
      position,
      dimension,
      activeTaskId,
      taskToRestore: activeTaskId,
      at: new Date().toISOString(),
    };
    this.lastRecord = record;

    this.options.events.emit(
      'bot:death',
      `bot died at ${position ? `${position.x}, ${position.y}, ${position.z}` : 'unknown position'}`,
      {
        ...record,
        cause,
      },
      { botId: this.options.botId, severity: 'error' },
    );

    return record;
  }

  async markRecovered(deathEventId: string): Promise<void> {
    try {
      await this.options.eventsRepository.markDeathRecovered(deathEventId);
    } catch (error) {
      this.options.logger.error({ err: error }, 'failed to mark death recovered');
    }
  }
}
