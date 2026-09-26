import type { Bot } from 'mineflayer';
// mineflayer's blockAt/position APIs call methods such as .floored() on the position,
// so a plain {x,y,z} literal is not sufficient; real Vec3 instances are required.
import { Vec3 as McVec3 } from 'vec3';
import {
  buildScanResult,
  blockKind,
  formatContainerCounts,
  isWithinRadius,
  type ContainerRecord,
  type Logger,
  type RawStorageBlock,
  type StorageScanResult,
  type Vec3,
  withTimeout,
} from '@unionkitbot/shared';
import type { AgentEventEmitter } from '../events.js';

/** Vanilla interaction reach is ~4.5 blocks; leave a small margin for position lag. */
const CONTAINER_REACH = 4.5;
const CONTAINER_OPEN_TIMEOUT_MS = 5_000;

export interface ScannerOptions {
  botId: string;
  logger: Logger;
  events: AgentEventEmitter;
  getBot: () => Bot | null;
  getDimension: () => string;
}

export interface ScanOptions {
  radius: number;
  inspectContents: boolean;
}

/**
 * Scans a radius around a delivery location for supported storage and counts logical
 * containers (double chests count once). Only blocks the client already knows about are
 * inspected - no world data is fabricated.
 */
export class StorageScanner {
  private readonly options: ScannerOptions;

  constructor(options: ScannerOptions) {
    this.options = options;
  }

  private collectBlocks(bot: Bot, origin: Vec3, radius: number): RawStorageBlock[] {
    const blocks: RawStorageBlock[] = [];
    const center = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
    const r = Math.ceil(radius);
    for (let x = center.x - r; x <= center.x + r; x += 1) {
      for (let y = center.y - r; y <= center.y + r; y += 1) {
        for (let z = center.z - r; z <= center.z + r; z += 1) {
          const block = bot.blockAt(new McVec3(x, y, z), false);
          if (!block || !block.name) continue;
          if (!blockKind(block.name)) continue;
          if (!isWithinRadius(center, { x, y, z }, radius)) continue;
          blocks.push({
            name: block.name,
            x,
            y,
            z,
            properties:
              (block as unknown as { _properties?: Record<string, unknown> })._properties ?? {},
          });
        }
      }
    }
    return blocks;
  }

  /**
   * Reads container contents where the client is permitted to. Failures are reported, not faked.
   * `bot.openContainer` never settles when the client cannot reach the block (a scan radius is
   * normally wider than interaction reach), so each attempt is bounded and skipped when out of
   * reach. Without this a single distant chest would stall the scan task indefinitely.
   */
  private async inspect(
    bot: Bot,
    containers: ContainerRecord[],
  ): Promise<{ inspected: number; contents: Map<string, unknown> }> {
    const contents = new Map<string, unknown>();
    let inspected = 0;
    const seen = new Set<string>();
    for (const container of containers) {
      if (seen.has(container.groupKey)) continue;
      seen.add(container.groupKey);
      const block = bot.blockAt(new McVec3(container.x, container.y, container.z), false);
      if (!block) continue;
      if (bot.entity && bot.entity.position.distanceTo(block.position) > CONTAINER_REACH) {
        this.options.logger.debug(
          { container: container.groupKey },
          'container out of reach; contents not read',
        );
        continue;
      }
      let window: Awaited<ReturnType<Bot['openContainer']>> | null = null;
      try {
        const opened = await withTimeout(
          bot.openContainer(block),
          CONTAINER_OPEN_TIMEOUT_MS,
          `openContainer ${container.groupKey}`,
        );
        window = opened;
        const items = opened.containerItems().map((item) => ({
          name: item.name,
          count: item.count,
        }));
        contents.set(container.groupKey, items);
        inspected += 1;
      } catch (error) {
        this.options.logger.debug(
          { err: error, container: container.groupKey },
          'container inspection failed',
        );
      } finally {
        try {
          window?.close();
        } catch {
          // Closing an already-invalid window is not actionable.
        }
      }
    }
    return { inspected, contents };
  }

  async scan(
    origin: Vec3,
    options: ScanOptions,
  ): Promise<{ result: StorageScanResult; contents: Map<string, unknown> }> {
    const bot = this.options.getBot();
    if (!bot) {
      const empty = buildScanResult({
        botId: this.options.botId,
        dimension: this.options.getDimension(),
        origin,
        radius: options.radius,
        blocks: [],
      });
      return { result: empty, contents: new Map() };
    }
    const blocks = this.collectBlocks(bot, origin, options.radius);
    let inspected = 0;
    let contents = new Map<string, unknown>();
    if (options.inspectContents) {
      const grouped = buildScanResult({
        botId: this.options.botId,
        dimension: this.options.getDimension(),
        origin,
        radius: options.radius,
        blocks,
      });
      const read = await this.inspect(bot, grouped.containers);
      inspected = read.inspected;
      contents = read.contents;
    }
    const result = buildScanResult({
      botId: this.options.botId,
      dimension: this.options.getDimension(),
      origin,
      radius: options.radius,
      blocks,
      inspected,
    });
    this.options.events.emit(
      'bot:storage-scan',
      `scanned ${blocks.length} storage blocks`,
      {
        scanId: result.scanId,
        origin,
        radius: options.radius,
        counts: result.counts,
        logicalContainerCount: result.logicalContainerCount,
        inspected,
        summary: formatContainerCounts(result.counts),
      },
      { botId: this.options.botId },
    );
    return { result, contents };
  }
}
