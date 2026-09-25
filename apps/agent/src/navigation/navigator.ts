import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
// mineflayer-pathfinder is CommonJS, so it must be default-imported and destructured;
// named ESM imports fail at runtime under Node's ESM loader.
import mineflayerPathfinder from 'mineflayer-pathfinder';
import {
  CancelToken,
  CancellationError,
  NavigationError,
  TimeoutError,
  createStuckTracker,
  formatVec3,
  horizontalDistance,
  resetStuckTracker,
  updateStuckTracker,
  type AgentSettings,
  type Logger,
  type Vec3,
} from '@unionkitbot/shared';
import type { AgentEventEmitter } from '../events.js';

const { goals, Movements } = mineflayerPathfinder;

export interface NavigationTarget {
  kind: 'coordinates' | 'entity' | 'follow';
  position?: Vec3;
  entityId?: number;
  username?: string;
  label: string;
}

export interface NavigationResult {
  ok: boolean;
  reason: string;
  finalPosition: Vec3 | null;
  replans: number;
  elapsedMs: number;
}

/**
 * Minimal shape of a mineflayer player entry. `entity` is the real mineflayer entity
 * (used directly by the pathfinder) and is only narrowed for our own field access.
 */
export interface PlayerLike {
  username: string;
  uuid?: string | null;
  ping?: number | null;
  entity?: Entity | null;
}

export type PlayerEntity = Entity;

export interface NavigatorOptions {
  botId: string;
  logger: Logger;
  events: AgentEventEmitter;
  settings: AgentSettings;
  getBot: () => Bot | null;
}

/**
 * Wraps mineflayer-pathfinder with stuck detection, replanning, timeout and cancellation.
 * No anti-cheat bypasses are performed; movement uses the vanilla pathfinder goals only.
 */
export class Navigator {
  private readonly options: NavigatorOptions;
  private token: CancelToken | null = null;
  private status = 'idle';
  private lastResult: NavigationResult | null = null;
  private activeTarget: NavigationTarget | null = null;

  constructor(options: NavigatorOptions) {
    this.options = options;
  }

  get currentStatus(): string {
    return this.status;
  }

  get target(): string | null {
    return this.activeTarget?.label ?? null;
  }

  get lastNavigation(): NavigationResult | null {
    return this.lastResult;
  }

  private requireBot(): Bot {
    const bot = this.options.getBot();
    if (!bot) throw new NavigationError('cannot navigate while disconnected');
    return bot;
  }

  private configureMovements(bot: Bot): void {
    try {
      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);
    } catch (error) {
      this.options.logger.debug({ err: error }, 'failed to configure movements');
    }
  }

  /** Resolves an online player by exact then case-insensitive username match. */
  findPlayer(username: string): PlayerEntity | null {
    const bot = this.requireBot();
    const players = bot.players as Record<string, PlayerLike>;
    const exact = players[username];
    if (exact?.entity) return exact.entity;
    const lower = username.toLowerCase();
    for (const [name, player] of Object.entries(players)) {
      if (name.toLowerCase() === lower && player.entity) return player.entity;
    }
    return null;
  }

  listPlayers(): Array<{
    username: string;
    uuid: string | null;
    position: Vec3 | null;
    ping: number | null;
  }> {
    const bot = this.options.getBot();
    if (!bot) return [];
    return Object.values(bot.players as Record<string, PlayerLike>).map((player) => ({
      username: player.username,
      uuid: player.uuid ?? null,
      position: player.entity?.position
        ? {
            x: player.entity.position.x,
            y: player.entity.position.y,
            z: player.entity.position.z,
          }
        : null,
      ping: typeof player.ping === 'number' ? player.ping : null,
    }));
  }

  cancel(reason = 'cancelled'): void {
    if (this.token) {
      this.token.cancel();
      this.token = null;
    }
    const bot = this.options.getBot();
    if (bot) {
      try {
        bot.pathfinder.stop();
      } catch (error) {
        this.options.logger.debug({ err: error }, 'pathfinder.stop threw');
      }
    }
    this.status = `cancelled: ${reason}`;
  }

  private makeToken(): CancelToken {
    this.cancel('superseded by new navigation');
    const token = new CancelToken();
    this.token = token;
    return token;
  }

  private buildGoal(bot: Bot, target: NavigationTarget) {
    if (target.kind === 'coordinates' && target.position) {
      const p = target.position;
      return new goals.GoalNear(
        Math.floor(p.x),
        Math.floor(p.y),
        Math.floor(p.z),
        Math.max(1, Math.floor(this.options.settings.navigation.goalRadius)),
      );
    }
    if (target.kind === 'follow' && target.username) {
      const entity = this.findPlayer(target.username);
      if (!entity) throw new NavigationError(`player ${target.username} is not visible`);
      return new goals.GoalFollow(entity, this.options.settings.navigation.goalRadius);
    }
    if (target.kind === 'entity' && target.entityId !== undefined) {
      const entity = bot.entities[target.entityId];
      if (!entity) throw new NavigationError('target entity disappeared');
      return new goals.GoalFollow(entity, this.options.settings.navigation.goalRadius);
    }
    throw new NavigationError('incomplete navigation target');
  }

  /**
   * OBSERVE -> DECIDE -> ACT -> VERIFY loop for movement:
   * set the pathfinder goal, poll position, replan when stuck, stop when the goal is reached.
   */
  async navigateTo(target: NavigationTarget): Promise<NavigationResult> {
    const bot = this.requireBot();
    const nav = this.options.settings.navigation;
    const token = this.makeToken();
    this.activeTarget = target;
    const startedAt = Date.now();
    let replans = 0;
    this.configureMovements(bot);
    const tracker = createStuckTracker();

    try {
      let goal = this.buildGoal(bot, target);
      bot.pathfinder.setGoal(goal, false);
      this.status = `navigating to ${target.label}`;
      this.options.events.emit(
        'bot:state',
        `navigating to ${target.label}`,
        {
          target: target.label,
        },
        { botId: this.options.botId },
      );
      resetStuckTracker(tracker, this.positionOf(bot));

      let lastReplanAt = 0;
      for (;;) {
        token.throwIfCancelled();
        await new Promise((resolve) => setTimeout(resolve, 250));
        token.throwIfCancelled();

        if (Date.now() - startedAt > nav.pathTimeoutMs) {
          throw new TimeoutError(`navigation to ${target.label} exceeded ${nav.pathTimeoutMs}ms`);
        }

        const position = this.positionOf(bot);

        const stuck = updateStuckTracker(tracker, position, nav.stuckThreshold);
        if (stuck) {
          if (Date.now() - lastReplanAt < nav.replanCooldownMs) {
            // Wait out the cooldown instead of hammering the pathfinder.
            continue;
          }
          replans += 1;
          lastReplanAt = Date.now();
          this.options.events.emit(
            'bot:log',
            `stuck near ${formatVec3(position)}; replanning`,
            {
              position,
              replans,
            },
            { botId: this.options.botId, severity: 'warn' },
          );
          try {
            bot.pathfinder.stop();
          } catch (error) {
            this.options.logger.debug({ err: error }, 'stop during replan threw');
          }
          goal = this.buildGoal(bot, target);
          bot.pathfinder.setGoal(goal, false);
          resetStuckTracker(tracker, position);
          if (replans > 12) {
            throw new NavigationError(`stuck for too long while navigating to ${target.label}`);
          }
          continue;
        }

        if (this.reached(bot, target, position)) {
          const result: NavigationResult = {
            ok: true,
            reason: 'goal reached',
            finalPosition: position,
            replans,
            elapsedMs: Date.now() - startedAt,
          };
          this.lastResult = result;
          this.status = 'idle';
          this.options.events.emit(
            'bot:log',
            `arrived at ${target.label}`,
            {
              position,
              replans,
            },
            { botId: this.options.botId },
          );
          return result;
        }
      }
    } catch (error) {
      const cancelled = error instanceof CancellationError;
      const reason = error instanceof Error ? error.message : String(error);
      const result: NavigationResult = {
        ok: false,
        reason,
        finalPosition: this.positionOf(bot),
        replans,
        elapsedMs: Date.now() - startedAt,
      };
      this.lastResult = result;
      this.status = cancelled ? 'cancelled' : `failed: ${reason}`;
      this.options.events.emit(
        'bot:log',
        `navigation failed: ${reason}`,
        { reason },
        {
          botId: this.options.botId,
          severity: cancelled ? 'info' : 'warn',
        },
      );
      return result;
    } finally {
      if (this.token === token) this.token = null;
      this.activeTarget = null;
    }
  }

  async gotoCoordinates(position: Vec3, label?: string): Promise<NavigationResult> {
    return this.navigateTo({
      kind: 'coordinates',
      position,
      label: label ?? formatVec3(position),
    });
  }

  async followPlayer(username: string): Promise<NavigationResult> {
    return this.navigateTo({ kind: 'follow', username, label: `player ${username}` });
  }

  private positionOf(bot: Bot): Vec3 {
    return { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
  }

  private reached(bot: Bot, target: NavigationTarget, position: Vec3): boolean {
    const radius = this.options.settings.navigation.goalRadius;
    if (target.kind === 'coordinates' && target.position) {
      return horizontalDistance(position, target.position) <= radius + 0.5;
    }
    if ((target.kind === 'follow' || target.kind === 'entity') && target.username) {
      const entity = this.findPlayer(target.username);
      if (!entity) return false;
      return horizontalDistance(position, entity.position) <= radius + 0.5;
    }
    if (target.kind === 'entity' && target.entityId !== undefined) {
      const entity = bot.entities[target.entityId];
      if (!entity) return true;
      return horizontalDistance(position, entity.position) <= radius + 0.5;
    }
    return true;
  }
}
