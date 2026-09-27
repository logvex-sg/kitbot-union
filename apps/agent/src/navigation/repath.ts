/**
 * Pure navigation recovery logic.
 *
 * Kept free of mineflayer imports so the repath and failure-classification rules can be
 * unit tested directly, and so the delivery/return code can reuse them without pulling in
 * the pathfinder.
 */

/** Classifies a navigation failure so the UI can group recurring causes. */
export function classifyNavigationFailure(reason: string, stuck: boolean): string {
  if (stuck) return 'stuck';
  const lower = reason.toLowerCase();
  if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout';
  if (lower.includes('cancelled') || lower.includes('canceled')) return 'cancelled';
  if (lower.includes('disconnected')) return 'disconnected';
  if (lower.includes('no path') || lower.includes('nopath')) return 'no_path';
  if (lower.includes('goal')) return 'unreachable_goal';
  return 'unknown';
}

export interface RepathDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Whether a replan should be attempted, and when a route is considered hopeless.
 *
 * Two guards stop the bot endlessly retrying an impossible route: a hard cap on replans,
 * and a progress requirement. If replans keep producing no measurable movement, the
 * no-progress budget is consumed faster, so a hopeless route fails quickly instead of
 * occupying the bot until the overall path timeout.
 */
export function decideRepath(input: {
  replans: number;
  maxRepathAttempts: number;
  movedSinceLastReplan: boolean;
  attemptsSinceProgress: number;
  maxAttemptsWithoutProgress: number;
}): RepathDecision {
  if (input.replans >= input.maxRepathAttempts) {
    return { allowed: false, reason: `exceeded ${input.maxRepathAttempts} replan attempts` };
  }
  if (
    !input.movedSinceLastReplan &&
    input.attemptsSinceProgress >= input.maxAttemptsWithoutProgress
  ) {
    return {
      allowed: false,
      reason: `no progress after ${input.attemptsSinceProgress} replans`,
    };
  }
  return { allowed: true, reason: 'replanning' };
}

/**
 * Tracks movement between replans so `decideRepath` can tell progress from thrashing.
 *
 * The epsilon is in blocks: anything smaller than a fraction of a block is treated as
 * "did not move", which is what distinguishes a genuine repath from jitter.
 */
export class ProgressTracker {
  private lastPosition: { x: number; y: number; z: number } | null = null;
  private attemptsSinceProgress = 0;

  constructor(private readonly epsilon = 0.5) {}

  /**
   * Records a position observed at a replan and reports whether the bot had moved since
   * the previous replan.
   */
  observe(position: { x: number; y: number; z: number }): boolean {
    const previous = this.lastPosition;
    this.lastPosition = position;
    if (!previous) return true;
    const dx = position.x - previous.x;
    const dz = position.z - previous.z;
    const moved = Math.sqrt(dx * dx + dz * dz) >= this.epsilon;
    if (moved) {
      this.attemptsSinceProgress = 0;
    } else {
      this.attemptsSinceProgress += 1;
    }
    return moved;
  }

  get withoutProgress(): number {
    return this.attemptsSinceProgress;
  }

  reset(): void {
    this.lastPosition = null;
    this.attemptsSinceProgress = 0;
  }
}
