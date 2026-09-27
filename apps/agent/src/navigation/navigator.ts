import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
// mineflayer-pathfinder is CommonJS, so it must be default-imported and destructured;
// named ESM imports fail at runtime under Node's ESM loader.
import mineflayerPathfinder from 'mineflayer-pathfinder';
import {
  CancelToken,
  CancellationError,
  MIN_MOVEMENT_EPSILON,
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
import { classifyNavigationFailure, decideRepath } from './repath.js';

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
  /** True when the failure was caused by the bot being unable to move. */
  stuck: boolean;
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
  /** Persists a navigation failure. Optional so the navigator works without a database. */
  onFailure?: (failure: {
    label: string;
    reason: string;
    category: string;
    replans: number;
    elapsedMs: number;
    from: Vec3 | null;
    to: Vec3 | null;
    stuck: boolean;
    dimension: string | null;
  }) => void | Promise<void>;
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
  private movementsApplied = false;

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

  /**
   * Applies the configured movement options to the pathfinder.
   *
   * `canDig` is forced off unless explicitly enabled: breaking blocks to reach a goal is a
   * server-specific privilege, never something the bot should assume. No anti-cheat or
   * exploit-based movement is configured here.
   */
  private configureMovements(bot: Bot): void {
    try {
      const movements = new Movements(bot);
      const nav = this.options.settings.navigation;
      const withDig = movements as unknown as { canDig?: boolean };
      withDig.canDig = nav.canDig === true;
      if (nav.avoidDangerousBlocks) {
        // Prefer safe terrain: avoid walking through liquids and other hazards the
        // pathfinder knows about. Unsupported flags are simply ignored by the library.
        const advanced = movements as unknown as Record<string, unknown>;
        if (!('allow1by1towers' in advanced)) advanced['allow1by1towers'] = false;
        if (!('allowFreeMotion' in advanced)) advanced['allowFreeMotion'] = false;
      }
      bot.pathfinder.setMovements(movements);
      this.movementsApplied = true;
    } catch (error) {
      // A pathfinder API change must not stop navigation: the library's defaults apply.
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
    let attemptsSinceProgress = 0;
    let lastReplanPosition: Vec3 | null = null;
    let everStuck = false;
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
          everStuck = true;
          if (Date.now() - lastReplanAt < nav.replanCooldownMs) {
            // Wait out the cooldown instead of hammering the pathfinder.
            continue;
          }
          // Progress is measured between replans: a replan that moved the bot counts as
          // progress, one that did not means the route is likely impossible.
          const movedSinceLastReplan =
            lastReplanPosition === null ||
            horizontalDistance(lastReplanPosition, position) >= MIN_MOVEMENT_EPSILON;
          if (!movedSinceLastReplan) {
            attemptsSinceProgress += 1;
          } else {
            attemptsSinceProgress = 0;
          }
          const decision = decideRepath({
            replans,
            maxRepathAttempts: nav.maxRepathAttempts,
            movedSinceLastReplan,
            attemptsSinceProgress,
            maxAttemptsWithoutProgress: Math.max(3, Math.floor(nav.maxRepathAttempts / 2)),
          });
          if (!decision.allowed) {
            throw new NavigationError(
              `cannot reach ${target.label}: ${decision.reason} (stuck near ${formatVec3(position)})`,
            );
          }
          replans += 1;
          lastReplanAt = Date.now();
          lastReplanPosition = position;
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
          continue;
        }

        if (this.reached(bot, target, position)) {
          const result: NavigationResult = {
            ok: true,
            reason: 'goal reached',
            finalPosition: position,
            replans,
            elapsedMs: Date.now() - startedAt,
            stuck: false,
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
      const finalPosition = this.positionOf(bot);
      const result: NavigationResult = {
        ok: false,
        reason,
        finalPosition,
        replans,
        elapsedMs: Date.now() - startedAt,
        stuck: everStuck && !cancelled,
      };
      this.lastResult = result;
      this.status = cancelled ? 'cancelled' : `failed: ${reason}`;
      this.options.events.emit(
        'bot:log',
        `navigation failed: ${reason}`,
        { reason, replans, category: classifyNavigationFailure(reason, result.stuck) },
        {
          botId: this.options.botId,
          severity: cancelled ? 'info' : 'warn',
        },
      );
      // Cancellation is an operator action, not a defect worth persisting as a failure.
      if (!cancelled) {
        await this.recordFailure(target, result, finalPosition);
      }
      return result;
    } finally {
      if (this.token === token) this.token = null;
      this.activeTarget = null;
    }
  }

  /** Reports a navigation failure to the persistence hook, if one is configured. */
  private async recordFailure(
    target: NavigationTarget,
    result: NavigationResult,
    finalPosition: Vec3 | null,
  ): Promise<void> {
    if (!this.options.onFailure) return;
    try {
      await this.options.onFailure({
        label: target.label,
        reason: result.reason,
        category: classifyNavigationFailure(result.reason, result.stuck),
        replans: result.replans,
        elapsedMs: result.elapsedMs,
        from: finalPosition,
        to: target.position ?? null,
        stuck: result.stuck,
        dimension: null,
      });
    } catch (error) {
      this.options.logger.debug({ err: error }, 'failed to record navigation failure');
    }
  }

  async gotoCoordinates(position: Vec3, label?: string): Promise<NavigationResult> {
    return this.navigateTo({
      kind: 'coordinates',
      position,
      label: label ?? formatVec3(position),
    });
  }

  /**
   * Navigates to a stored waypoint.
   *
   * The waypoint's coordinates are the goal; its name is only a label. A waypoint in a
   * different dimension cannot be walked to, so that is refused explicitly rather than
   * producing a path across the world.
   */
  async gotoWaypoint(
    waypoint: { name: string; dimension: string; x: number; y: number; z: number },
    currentDimension: string,
  ): Promise<NavigationResult> {
    if (waypoint.dimension !== currentDimension) {
      return {
        ok: false,
        reason: `waypoint ${waypoint.name} is in ${waypoint.dimension}, bot is in ${currentDimension}`,
        finalPosition: null,
        replans: 0,
        elapsedMs: 0,
        stuck: false,
      };
    }
    return this.gotoCoordinates(
      { x: waypoint.x, y: waypoint.y, z: waypoint.z },
      `waypoint ${waypoint.name}`,
    );
  }

  async followPlayer(username: string): Promise<NavigationResult> {
    return this.navigateTo({ kind: 'follow', username, label: `player ${username}` });
  }

  private positionOf(bot: Bot): Vec3 {
    return { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
  }

  private reached(bot: Bot, target: NavigationTarget, position: Vec3): boolean {
    // waypointTolerance is the operator-facing setting; goalRadius remains the fallback so
    // an older settings blob without the new key keeps working.
    const radius = this.options.settings.navigation.waypointTolerance
      ?? this.options.settings.navigation.goalRadius;
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

  /**
   * Distance from the bot to an online player, or null when the player or bot is not
   * available. Used by delivery to decide whether the recipient is close enough to drop to.
   */
  playerDistance(username: string): number | null {
    const bot = this.options.getBot();
    if (!bot) return null;
    const entity = this.findPlayer(username);
    if (!entity) return null;
    const position = bot.entity.position;
    const dx = position.x - entity.position.x;
    const dy = position.y - entity.position.y;
    const dz = position.z - entity.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
