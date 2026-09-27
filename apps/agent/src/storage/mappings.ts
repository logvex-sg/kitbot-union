import type { KitDefinition, Logger } from '@unionkitbot/shared';
import type { KitRepository, StorageMappingRepository } from '@unionkitbot/database';
import type { AgentEventEmitter } from '../events.js';
import type { RecognisedContainer } from './signs.js';

export interface StorageMappingServiceOptions {
  botId: string;
  server: string;
  logger: Logger;
  events: AgentEventEmitter;
  mappings: StorageMappingRepository;
  kits: KitRepository;
  getDimension: () => string;
}

export interface MappingPersistSummary {
  written: number;
  matched: number;
  ambiguous: number;
  unresolved: number;
}

/**
 * Persists the kit label observed on each container's sign.
 *
 * The repository's upsert preserves manual overrides, so re-scanning an area refreshes
 * detection without discarding an operator's correction. Individual write failures are
 * logged and counted rather than thrown: a database hiccup must not fail a scan that
 * already succeeded.
 */
export class StorageMappingService {
  private readonly options: StorageMappingServiceOptions;

  constructor(options: StorageMappingServiceOptions) {
    this.options = options;
  }

  /** Kits consulted for sign aliases, filtered to those opted into automatic labelling. */
  async kits(): Promise<KitDefinition[]> {
    return this.options.kits.list();
  }

  async record(
    recognised: readonly RecognisedContainer[],
    scanId: string | null = null,
  ): Promise<MappingPersistSummary> {
    const dimension = this.options.getDimension();
    const summary: MappingPersistSummary = {
      written: 0,
      matched: 0,
      ambiguous: 0,
      unresolved: 0,
    };

    for (const entry of recognised) {
      // An ambiguous or unmatched sign stores no detected kit, which is what keeps the
      // container in the "unresolved" bucket for an operator to label.
      const detected = entry.match.matched ? entry.match.kitId : null;
      try {
        await this.options.mappings.upsert({
          botId: this.options.botId,
          server: this.options.server,
          dimension,
          container: entry.container,
          attach: entry.attach,
          detectedKitId: detected,
          ambiguous: entry.match.ambiguous,
          reason: entry.match.reason,
          scanId,
        });
        summary.written += 1;
        if (entry.match.matched) summary.matched += 1;
        if (entry.match.ambiguous) summary.ambiguous += 1;
        if (!entry.match.matched && !entry.match.ambiguous) summary.unresolved += 1;
      } catch (error) {
        this.options.logger.warn(
          { err: error, groupKey: entry.container.groupKey },
          'failed to persist a storage mapping',
        );
      }
    }

    if (summary.written > 0) {
      this.options.events.emit(
        'bot:storage-scan',
        `recorded ${summary.written} storage mapping(s)`,
        { ...summary, dimension },
        { botId: this.options.botId },
      );
    }
    return summary;
  }

  /** Maps signed storage to kits for the given dimension. */
  async forKit(kitId: string) {
    return this.options.mappings.findByKit(this.options.botId, kitId);
  }

  async list() {
    return this.options.mappings.list({ botId: this.options.botId, limit: 500 });
  }

  /**
   * Applies an operator override. Passing a null kit id reverts to automatic detection.
   */
  async override(groupOrId: string, kitId: string | null, by: string) {
    const direct = await this.options.mappings.get(groupOrId);
    if (direct) return this.options.mappings.setOverride(direct.id, kitId, by, kitId !== null);
    const match = (await this.list()).find((m) => m.groupKey === groupOrId);
    if (!match) return null;
    return this.options.mappings.setOverride(match.id, kitId, by, kitId !== null);
  }
}
