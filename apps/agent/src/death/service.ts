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
  /**
   * Bot state at the time of death, e.g. DELIVERING. Optional: death logging must still
   * succeed when the runtime is already tearing down and cannot report its state.
   */
  getState?: () => string;
  /** world/server label, recorded so a death can be attributed to a world. */
  server?: string;
  /** Order in flight when the bot died, used by recovery to release its reservation. */
  getActiveOrderId?: () => string | null;
}

export interface DeathRecord {
  deathEventId: string;
  waypointId: string | null;
  position: Vec3 | null;
  dimension: string;
  activeTaskId: string | null;
  activeOrderId: string | null;
  botState: string;
  server: string;
  taskToRestore: string | null;
  at: string;
}

/**
 * Handles legitimate deaths only - the bot never kills itself. Records the event,
 * the coordinates, the active task and creates a DEATH waypoint for recovery.
 *
 * Every recorded death is emitted as `bot:death`, which the webhook dispatcher uses for
 * the `bot_death` notification, so death reporting and death logging share one path.
 */
export class DeathService {
  private readonly options: DeathServiceOptions;
  private lastRecord: DeathRecord | null = null;
  private readonly history: DeathRecord[] = [];

  constructor(options: DeathServiceOptions) {
    this.options = options;
  }

  get lastDeath(): DeathRecord | null {
    return this.lastRecord;
  }

  /** Most recent deaths, newest last. In-memory mirror of the persisted history. */
  recent(limit = 20): DeathRecord[] {
    return this.history.slice(-limit);
  }

  async recordDeath(position: Vec3 | null, cause: string | null): Promise<DeathRecord> {
    const dimension = this.options.getDimension();
    const activeTaskId = this.options.getActiveTaskId();
    const activeOrderId = this.options.getActiveOrderId?.() ?? null;
    const botState = this.options.getState?.() ?? 'UNKNOWN';
    const server = this.options.server ?? 'unknown';

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
          metadata: { cause, activeTaskId, activeOrderId, botState, server },
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
      botState,
      server,
      activeOrderId,
      metadata: { username: this.options.username },
    });

    const record: DeathRecord = {
      deathEventId,
      waypointId,
      position,
      dimension,
      activeTaskId,
      activeOrderId,
      botState,
      server,
      taskToRestore: activeTaskId,
      at: new Date().toISOString(),
    };
    this.lastRecord = record;
    this.history.push(record);
    if (this.history.length > 100) this.history.shift();

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
