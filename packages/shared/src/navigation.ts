import type { Vec3 } from './types.js';

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function hasReached(position: Vec3, goal: Vec3, goalRadius: number): boolean {
  return distance(position, goal) <= goalRadius;
}

export interface StuckTracker {
  lastPosition: Vec3 | null;
  lastMoveAt: number;
  samples: number;
}

export const MIN_MOVEMENT_EPSILON = 0.35;

export function createStuckTracker(now = Date.now()): StuckTracker {
  return { lastPosition: null, lastMoveAt: now, samples: 0 };
}

/**
 * Feeds the tracker a new position. Returns true once the bot has failed to move
 * meaningfully for `thresholdMs`, which the navigator treats as "stuck".
 */
export function updateStuckTracker(
  tracker: StuckTracker,
  position: Vec3,
  thresholdMs: number,
  now = Date.now(),
): boolean {
  if (!tracker.lastPosition) {
    tracker.lastPosition = position;
    tracker.lastMoveAt = now;
    return false;
  }
  const moved = horizontalDistance(tracker.lastPosition, position);
  if (moved < MIN_MOVEMENT_EPSILON) {
    tracker.samples += 1;
    return now - tracker.lastMoveAt >= thresholdMs;
  }
  tracker.lastPosition = position;
  tracker.lastMoveAt = now;
  tracker.samples = 0;
  return false;
}

export function resetStuckTracker(tracker: StuckTracker, position: Vec3, now = Date.now()): void {
  tracker.lastPosition = position;
  tracker.lastMoveAt = now;
  tracker.samples = 0;
}

/** Chooses a standable position beside a target so the bot does not path into the block. */
export function approachOffset(goal: Vec3, distanceAway: number, angleRadians = Math.PI): Vec3 {
  return {
    x: Math.round(goal.x + Math.cos(angleRadians) * distanceAway),
    y: goal.y,
    z: Math.round(goal.z + Math.sin(angleRadians) * distanceAway),
  };
}

export function parseGotoArgs(args: string[]): Vec3 | null {
  if (args.length < 3) return null;
  const [x, y, z] = args;
  if (x === undefined || y === undefined || z === undefined) return null;
  const nums = [Number(x), Number(y), Number(z)];
  if (nums.some((n) => Number.isNaN(n))) return null;
  return { x: nums[0]!, y: nums[1]!, z: nums[2]! };
}

export function formatVec3(v: Vec3): string {
  return `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;
}
