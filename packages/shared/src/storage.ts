import { randomUUID } from 'node:crypto';
import type { ContainerKind, ContainerRecord, StorageScanResult, Vec3 } from './types.js';

export const SUPPORTED_STORAGE_BLOCKS: Record<string, ContainerKind> = {
  chest: 'CHEST',
  barrel: 'BARREL',
  shulker_box: 'SHULKER_BOX',
  trapped_chest: 'TRAPPED_CHEST',
  ender_chest: 'ENDER_CHEST',
};

export interface RawStorageBlock {
  name: string;
  x: number;
  y: number;
  z: number;
  properties?: Record<string, unknown>;
}

export function bareBlockName(blockName: string): string {
  return blockName.includes(':') ? blockName.split(':')[1]!.toLowerCase() : blockName.toLowerCase();
}

export function blockKind(blockName: string): ContainerKind | null {
  return SUPPORTED_STORAGE_BLOCKS[bareBlockName(blockName)] ?? null;
}

function isChest(kind: ContainerKind | null): boolean {
  return kind === 'CHEST' || kind === 'TRAPPED_CHEST';
}

/**
 * Groups adjacent chest blocks into logical containers. A double chest counts as ONE.
 * Pairing happens only along a single horizontal axis (never diagonal, never vertical),
 * which matches how Minecraft forms double chests.
 */
export function groupContainers(blocks: RawStorageBlock[]): ContainerRecord[] {
  const records: ContainerRecord[] = [];
  const consumed = new Set<number>();
  const chestIndices = blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => isChest(blockKind(b.name)));

  for (const { b, i } of chestIndices) {
    if (consumed.has(i)) continue;
    let partner = -1;
    for (const candidate of chestIndices) {
      if (candidate.i === i || consumed.has(candidate.i)) continue;
      const c = candidate.b;
      if (c.y !== b.y) continue;
      const dx = Math.abs(c.x - b.x);
      const dz = Math.abs(c.z - b.z);
      if ((dx === 1 && dz === 0) || (dx === 0 && dz === 1)) {
        partner = candidate.i;
        break;
      }
    }
    const kind = blockKind(b.name)!;
    if (partner >= 0) {
      const c = blocks[partner]!;
      consumed.add(partner);
      consumed.add(i);
      const groupKey = `dc:${Math.min(b.x, c.x)},${b.y},${Math.min(b.z, c.z)}`;
      const mergedKind: ContainerKind = kind === 'TRAPPED_CHEST' ? 'TRAPPED_CHEST' : 'DOUBLE_CHEST';
      records.push({
        kind: mergedKind,
        x: Math.min(b.x, c.x),
        y: b.y,
        z: Math.min(b.z, c.z),
        blockName: b.name,
        groupKey,
      });
    } else {
      consumed.add(i);
      records.push({
        kind,
        x: b.x,
        y: b.y,
        z: b.z,
        blockName: b.name,
        groupKey: `s:${b.x},${b.y},${b.z}`,
      });
    }
  }

  for (let i = 0; i < blocks.length; i += 1) {
    if (consumed.has(i)) continue;
    const b = blocks[i]!;
    const kind = blockKind(b.name);
    if (!kind || isChest(kind)) continue;
    records.push({
      kind,
      x: b.x,
      y: b.y,
      z: b.z,
      blockName: b.name,
      groupKey: `s:${b.x},${b.y},${b.z}`,
    });
  }

  return records.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
}

export function countContainers(containers: ContainerRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of containers) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  return counts;
}

/** True when the block centre lies within `radius` of the origin centre. */
export function isWithinRadius(
  origin: Vec3,
  block: Vec3,
  radius: number,
  blockRadius = 1,
): boolean {
  const dx = block.x + 0.5 - (origin.x + 0.5);
  const dy = block.y + 0.5 - (origin.y + 0.5);
  const dz = block.z + 0.5 - (origin.z + 0.5);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius + blockRadius;
}

export function buildScanResult(params: {
  botId: string;
  dimension: string;
  origin: Vec3;
  radius: number;
  blocks: RawStorageBlock[];
  inspected?: number;
  scanId?: string;
  now?: Date;
}): StorageScanResult {
  const containers = groupContainers(params.blocks);
  return {
    scanId: params.scanId ?? randomUUID(),
    botId: params.botId,
    dimension: params.dimension,
    origin: params.origin,
    radius: params.radius,
    timestamp: (params.now ?? new Date()).toISOString(),
    containers,
    counts: countContainers(containers),
    logicalContainerCount: containers.length,
    inspected: params.inspected ?? 0,
  };
}

/** Singular and plural labels; explicit plurals avoid "shulker boxs" style output. */
const CONTAINER_LABELS: Record<string, [singular: string, plural: string]> = {
  CHEST: ['chest', 'chests'],
  DOUBLE_CHEST: ['double chest', 'double chests'],
  BARREL: ['barrel', 'barrels'],
  SHULKER_BOX: ['shulker box', 'shulker boxes'],
  TRAPPED_CHEST: ['trapped chest', 'trapped chests'],
  ENDER_CHEST: ['ender chest', 'ender chests'],
};

export function formatContainerCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([kind, count]) => {
      const labels =
        CONTAINER_LABELS[kind] ??
        ([kind.toLowerCase(), `${kind.toLowerCase()}s`] as [string, string]);
      return `${count} ${count === 1 ? labels[0] : labels[1]}`;
    })
    .join(', ');
}
