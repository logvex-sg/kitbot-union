import type { Vec3 } from './types.js';

/**
 * Chest sign kit recognition.
 *
 * A chest's kit type is inferred from a sign placed on or beside it. Sign text is
 * player-authored, so parsing is deliberately conservative: unrecognised or ambiguous
 * text yields no match rather than a guess, and every alias is configurable.
 */

/** Lines a Minecraft sign can hold; extra lines are ignored. */
export const SIGN_LINE_COUNT = 4;

/** Maximum length of a single sign line as the vanilla client reports it. */
export const SIGN_LINE_MAX_LENGTH = 15;

export interface SignData {
  x: number;
  y: number;
  z: number;
  /** Front-face text, one entry per line, in reading order. */
  lines: string[];
  /** Wall signs and hanging signs attach to a block; standing signs are free-standing. */
  attachedTo?: Vec3 | null;
}

export interface StorageSignAttach {
  sign: SignData;
  /** Distance from the sign to the chest it was associated with. */
  distance: number;
}

/**
 * Strips Minecraft formatting codes and normalises a sign line for matching.
 *
 * Handles the two formatting forms the client can produce: the legacy section-sign
 * sequence (`\u00a7a`) and the JSON/text-component residue `§`-encoded runs that survive
 * `toString()`. Colour codes carry no meaning for kit recognition, so they are dropped.
 */
export function stripSignFormatting(line: string): string {
  return line.replace(/\u00a7[0-9A-FK-ORa-fk-or]/g, '');
}

/**
 * Normalises one sign line to a comparison key.
 *
 * Lowercases, strips formatting, collapses internal whitespace, removes surrounding
 * punctuation and drops Minecraft's sign "glow"/colour decorations. A blank line
 * normalises to an empty string so callers can skip it.
 */
export function normalizeSignLine(line: unknown): string {
  if (line === null || line === undefined) return '';
  const text = stripSignFormatting(String(line))
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return text;
}

/**
 * Normalises a whole sign into candidate keys, one per non-empty line, plus the
 * concatenation of all lines.
 *
 * The concatenation catches signs whose label is split across lines, which is common
 * when a player writes "PVP" on line 1 and "KIT" on line 2.
 */
export function signCandidates(lines: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const line of lines.slice(0, SIGN_LINE_COUNT)) {
    const normalized = normalizeSignLine(line);
    if (normalized.length > 0) candidates.push(normalized);
  }
  const joined = normalizeSignLine(
    lines
      .slice(0, SIGN_LINE_COUNT)
      .map((line) => stripSignFormatting(String(line ?? '')))
      .join(' '),
  );
  if (joined.length > 0 && !candidates.includes(joined)) candidates.push(joined);
  return candidates;
}

export interface KitAliasEntry {
  /** Canonical kit id, matching `kits.id`. */
  kitId: string;
  /** Every string that should resolve to this kit, already normalised or raw. */
  aliases: string[];
}

export interface KitMatchResult {
  matched: boolean;
  kitId: string | null;
  /** The alias that matched, for display and debugging. */
  matchedAlias: string | null;
  /** True when more than one distinct kit matched the same sign. */
  ambiguous: boolean;
  /** All distinct kit ids that matched, in alias-definition order. */
  candidates: string[];
  reason: string;
}

/**
 * Matches normalised sign candidates against configured kit aliases.
 *
 * Ambiguity is reported instead of resolved: if one sign matches two different kits
 * (for example an alias "pvp" on kit A and "pvp kit" on kit B), the caller must not
 * silently pick one. A longer, more specific alias still counts as ambiguous when a
 * different kit also matches, because guessing here would mislabel real storage.
 */
export function matchKitBySign(
  candidates: readonly string[],
  aliasTable: readonly KitAliasEntry[],
): KitMatchResult {
  const index = buildAliasIndex(aliasTable);
  const matched = new Map<string, string>();

  for (const candidate of candidates) {
    const kitIds = index.get(candidate);
    if (!kitIds) continue;
    for (const kitId of kitIds) {
      if (!matched.has(kitId)) matched.set(kitId, candidate);
    }
  }

  const kitIds = [...matched.keys()];
  if (kitIds.length === 0) {
    return {
      matched: false,
      kitId: null,
      matchedAlias: null,
      ambiguous: false,
      candidates: [],
      reason: 'no configured kit alias matched the sign text',
    };
  }
  if (kitIds.length > 1) {
    return {
      matched: false,
      kitId: null,
      matchedAlias: null,
      ambiguous: true,
      candidates: kitIds,
      reason: `sign matches multiple kits: ${kitIds.join(', ')}`,
    };
  }
  const kitId = kitIds[0]!;
  return {
    matched: true,
    kitId,
    matchedAlias: matched.get(kitId) ?? null,
    ambiguous: false,
    candidates: kitIds,
    reason: `matched alias "${matched.get(kitId)}"`,
  };
}

/** Builds a normalised alias -> kit ids index. Duplicate aliases accumulate kit ids. */
export function buildAliasIndex(
  aliasTable: readonly KitAliasEntry[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const entry of aliasTable) {
    for (const raw of entry.aliases) {
      const alias = normalizeSignLine(raw);
      if (alias.length === 0) continue;
      const existing = index.get(alias) ?? [];
      if (!existing.includes(entry.kitId)) existing.push(entry.kitId);
      index.set(alias, existing);
    }
  }
  return index;
}

/**
 * Expands a kit definition into its alias table. The kit id and display name are always
 * aliases so an operator only has to configure the extras.
 */
export function aliasTableFromKits(
  kits: ReadonlyArray<{ id: string; name: string; aliases?: string[] }>,
): KitAliasEntry[] {
  return kits.map((kit) => ({
    kitId: kit.id,
    aliases: [kit.id, kit.name, ...(kit.aliases ?? [])].filter((a) => a.trim().length > 0),
  }));
}

/** Manhattan-adjacent or directly above/below counts as attached. */
export function isSignAdjacent(sign: Vec3, target: Vec3): boolean {
  const dx = Math.abs(sign.x - target.x);
  const dy = Math.abs(sign.y - target.y);
  const dz = Math.abs(sign.z - target.z);
  return dx + dy + dz <= 1;
}

export function signDistance(sign: Vec3, target: Vec3): number {
  const dx = sign.x - target.x;
  const dy = sign.y - target.y;
  const dz = sign.z - target.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Associates signs with storage blocks.
 *
 * Preference order, strongest first:
 *   1. a sign attached directly to the block (wall sign on the chest, or on the block above)
 *   2. the nearest sign within `maxDistance`
 * Each sign is claimed by at most one container, and each container takes at most one sign,
 * so a sign is never counted twice.
 */
export function associateSignsWithContainers(
  containers: ReadonlyArray<{ groupKey: string; x: number; y: number; z: number }>,
  signs: readonly SignData[],
  maxDistance = 2.5,
): Map<string, StorageSignAttach> {
  const result = new Map<string, StorageSignAttach>();
  const claimedSigns = new Set<number>();

  const scored: Array<{
    containerIndex: number;
    signIndex: number;
    distance: number;
    attached: boolean;
  }> = [];
  containers.forEach((container, containerIndex) => {
    const center = { x: container.x, y: container.y, z: container.z };
    signs.forEach((sign, signIndex) => {
      const distance = signDistance(sign, center);
      const attached =
        isSignAdjacent(sign, center) ||
        (sign.attachedTo ? isSignAdjacent(sign.attachedTo, center) : false);
      const above = isSignAdjacent(sign, { x: center.x, y: center.y + 1, z: center.z });
      if (!attached && !above && distance > maxDistance) return;
      scored.push({
        containerIndex,
        signIndex,
        distance: attached || above ? 0 : distance,
        attached: attached || above,
      });
    });
  });

  scored.sort((a, b) => a.distance - b.distance || a.containerIndex - b.containerIndex);

  const assignedContainers = new Set<number>();
  for (const candidate of scored) {
    if (claimedSigns.has(candidate.signIndex)) continue;
    if (assignedContainers.has(candidate.containerIndex) && !candidate.attached) continue;
    if (assignedContainers.has(candidate.containerIndex)) continue;
    const container = containers[candidate.containerIndex]!;
    const sign = signs[candidate.signIndex]!;
    claimedSigns.add(candidate.signIndex);
    assignedContainers.add(candidate.containerIndex);
    result.set(container.groupKey, { sign, distance: candidate.distance });
  }
  return result;
}

/** Applies a manual operator override on top of the detected value. */
export function effectiveKitId(
  detectedKitId: string | null,
  overrideKitId: string | null,
  overrideEnabled: boolean,
): string | null {
  if (overrideEnabled && overrideKitId) return overrideKitId;
  return detectedKitId;
}
