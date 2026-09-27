import type { Bot } from 'mineflayer';
import { Vec3 as McVec3 } from 'vec3';
import {
  SIGN_LINE_COUNT,
  associateSignsWithContainers,
  aliasTableFromKits,
  bareBlockName,
  matchKitBySign,
  signCandidates,
  type ContainerRecord,
  type KitAliasEntry,
  type KitDefinition,
  type KitMatchResult,
  type Logger,
  type SignData,
  type StorageSignAttach,
  type Vec3,
} from '@unionkitbot/shared';

/** Vanilla block names that can hold a sign kit label. */
const SIGN_BLOCKS = new Set([
  'oak_sign',
  'spruce_sign',
  'birch_sign',
  'jungle_sign',
  'acacia_sign',
  'dark_oak_sign',
  'mangrove_sign',
  'cherry_sign',
  'pale_oak_sign',
  'bamboo_sign',
  'crimson_sign',
  'warped_sign',
  'oak_wall_sign',
  'spruce_wall_sign',
  'birch_wall_sign',
  'jungle_wall_sign',
  'acacia_wall_sign',
  'dark_oak_wall_sign',
  'mangrove_wall_sign',
  'cherry_wall_sign',
  'pale_oak_wall_sign',
  'bamboo_wall_sign',
  'crimson_wall_sign',
  'warped_wall_sign',
  'oak_hanging_sign',
  'spruce_hanging_sign',
  'birch_hanging_sign',
  'jungle_hanging_sign',
  'acacia_hanging_sign',
  'dark_oak_hanging_sign',
  'mangrove_hanging_sign',
  'cherry_hanging_sign',
  'pale_oak_hanging_sign',
  'bamboo_hanging_sign',
  'crimson_hanging_sign',
  'warped_hanging_sign',
]);

export function isSignBlockName(blockName: string): boolean {
  return SIGN_BLOCKS.has(bareBlockName(blockName));
}

export interface SignReaderOptions {
  botId: string;
  logger: Logger;
  getBot: () => Bot | null;
}

/**
 * Reads sign text from blocks the client already knows about.
 *
 * mineflayer stores sign text as a JSON text component on the block, populated by the
 * server's `update_sign` packet. A sign the client has never received data for has no
 * text, which is reported as unreadable rather than guessed at.
 */
export class SignReader {
  private readonly options: SignReaderOptions;

  constructor(options: SignReaderOptions) {
    this.options = options;
  }

  /**
   * Finds signs around an origin and returns them with their text.
   *
   * A sign whose text cannot be decoded is returned with empty lines, so the caller can
   * distinguish "a sign exists but is unreadable" from "no sign at all".
   */
  collect(origin: Vec3, radius: number): SignData[] {
    const bot = this.options.getBot();
    if (!bot) return [];
    const signs: SignData[] = [];
    const center = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
    const r = Math.ceil(radius);
    for (let x = center.x - r; x <= center.x + r; x += 1) {
      for (let y = center.y - r; y <= center.y + r; y += 1) {
        for (let z = center.z - r; z <= center.z + r; z += 1) {
          const block = bot.blockAt(new McVec3(x, y, z), false);
          if (!block || !block.name) continue;
          if (!isSignBlockName(block.name)) continue;
          const lines = this.readLines(block);
          signs.push({
            x,
            y,
            z,
            lines,
            attachedTo: this.attachedTo(bot, block, x, y, z),
          });
        }
      }
    }
    return signs;
  }

  /**
   * Extracts up to four lines of plain text from a sign block.
   *
   * Text components are flattened by concatenating their `text`/`extra` leaves, which is
   * what a rendered sign shows. Any failure results in an empty line and a debug log
   * rather than an exception, because one malformed sign must not abort a whole scan.
   */
  private readLines(block: unknown): string[] {
    const signText = (block as { signText?: unknown[] }).signText;
    if (!Array.isArray(signText)) return [];
    const lines: string[] = [];
    for (let i = 0; i < SIGN_LINE_COUNT; i += 1) {
      lines.push(this.flatten(signText[i]));
    }
    return lines;
  }

  private flatten(component: unknown): string {
    if (component === null || component === undefined) return '';
    if (typeof component === 'string') return component;
    if (typeof component === 'number' || typeof component === 'boolean') return String(component);
    if (Array.isArray(component)) return component.map((c) => this.flatten(c)).join('');
    if (typeof component === 'object') {
      const record = component as Record<string, unknown>;
      let out = '';
      if (typeof record['text'] === 'string') out += record['text'];
      const extra = record['extra'];
      if (Array.isArray(extra)) out += extra.map((c) => this.flatten(c)).join('');
      // `translate` components (rare on signs) contribute their first string arg if present.
      const withArgs = record['with'];
      if (out.length === 0 && Array.isArray(withArgs)) {
        out += withArgs.map((c) => this.flatten(c)).join('');
      }
      return out;
    }
    return '';
  }

  /**
   * Best-effort attachment target for a wall/hanging sign.
   *
   * Minecraft encodes the attached face in block properties; when the property is absent
   * the caller falls back to proximity matching, so returning null is safe.
   */
  private attachedTo(bot: Bot, block: unknown, x: number, y: number, z: number): Vec3 | null {
    const properties = (block as { _properties?: Record<string, unknown> })._properties;
    const facing = properties?.['facing'];
    if (typeof facing !== 'string') return null;
    const offset: Record<string, [number, number]> = {
      north: [0, 1],
      south: [0, -1],
      east: [-1, 0],
      west: [1, 0],
    };
    const delta = offset[facing];
    if (!delta) return null;
    const target = new McVec3(x + delta[0], y, z + delta[1]);
    const targetBlock = bot.blockAt(target, false);
    if (!targetBlock) return null;
    return { x: target.x, y: target.y, z: target.z };
  }
}

export interface RecognisedContainer {
  container: ContainerRecord;
  attach: StorageSignAttach | null;
  match: KitMatchResult;
  /** Sign lines as read, for the API/UI to display even when unmatched. */
  signLines: string[] | null;
  /** True when a sign exists but its text could not be decoded. */
  unreadable: boolean;
}

export interface RecognitionResult {
  recognised: RecognisedContainer[];
  signsFound: number;
  kitsRecognised: number;
  ambiguous: number;
  unreadable: number;
}

/**
 * Associates signs with containers and resolves each one to a kit.
 *
 * Only kits with `storageAutoDetect` enabled contribute aliases, so an operator can keep a
 * kit out of automatic labelling without deleting it.
 */
export function recogniseStorage(
  containers: readonly ContainerRecord[],
  signs: readonly SignData[],
  kits: readonly KitDefinition[],
  maxDistance: number,
): RecognitionResult {
  const aliasTable: KitAliasEntry[] = aliasTableFromKits(
    kits
      .filter((kit) => kit.storageAutoDetect !== false)
      .map((kit) => ({
        id: kit.id,
        name: kit.name,
        ...(kit.aliases ? { aliases: kit.aliases } : {}),
      })),
  );
  const attaches = associateSignsWithContainers(containers, signs, maxDistance);
  const recognised: RecognisedContainer[] = [];
  let kitsRecognised = 0;
  let ambiguous = 0;
  let unreadable = 0;

  for (const container of containers) {
    const attach = attaches.get(container.groupKey) ?? null;
    const signLines = attach ? [ ...attach.sign.lines ] : null;
    const hasSign = attach !== null;
    const isUnreadable =
      hasSign && (attach!.sign.lines ?? []).every((line) => line.trim().length === 0);
    if (isUnreadable) unreadable += 1;

    const candidates = attach ? signCandidates(attach.sign.lines) : [];
    const match = matchKitBySign(candidates, aliasTable);
    if (match.matched) kitsRecognised += 1;
    if (match.ambiguous) ambiguous += 1;

    const entry: RecognisedContainer = {
      container,
      attach,
      match,
      signLines,
      unreadable: isUnreadable,
    };
    recognised.push(entry);
  }

  return {
    recognised,
    signsFound: signs.length,
    kitsRecognised,
    ambiguous,
    unreadable,
  };
}
