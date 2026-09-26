import type { InventorySlotSummary, InventorySummary, ItemRequirement } from './types.js';

export interface RawSlot {
  slot: number;
  name: string | null;
  count: number;
  displayName?: string;
}

/** "bread", "minecraft:bread" and "BREAD" all normalise to "bread". */
export function normalizeItemName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const withoutNamespace = trimmed.includes(':') ? (trimmed.split(':')[1] ?? trimmed) : trimmed;
  return withoutNamespace.replace(/\s+/g, '_');
}

export function buildInventorySummary(slots: RawSlot[], totalSlots = 36): InventorySummary {
  const items: InventorySlotSummary[] = [];
  for (const slot of slots) {
    if (!slot.name || slot.count <= 0) continue;
    const entry: InventorySlotSummary = {
      name: normalizeItemName(slot.name),
      count: slot.count,
      slot: slot.slot,
    };
    if (slot.displayName !== undefined) entry.displayName = slot.displayName;
    items.push(entry);
  }
  const usedSlots = items.length;
  return { usedSlots, totalSlots, items, emptySlots: Math.max(0, totalSlots - usedSlots) };
}

export function countItem(summary: InventorySummary, item: string): number {
  const target = normalizeItemName(item);
  return summary.items.filter((i) => i.name === target).reduce((sum, i) => sum + i.count, 0);
}

export function missingRequirements(
  summary: InventorySummary,
  requirements: ItemRequirement[],
): ItemRequirement[] {
  const missing: ItemRequirement[] = [];
  for (const requirement of requirements) {
    const have = countItem(summary, requirement.item);
    if (have < requirement.count)
      missing.push({ item: requirement.item, count: requirement.count - have });
  }
  return missing;
}

export function hasAllRequirements(
  summary: InventorySummary,
  requirements: ItemRequirement[],
): boolean {
  return missingRequirements(summary, requirements).length === 0;
}

export interface InventoryDiff {
  removed: Record<string, number>;
  added: Record<string, number>;
}

export function diffInventory(before: InventorySummary, after: InventorySummary): InventoryDiff {
  const removed: Record<string, number> = {};
  const added: Record<string, number> = {};
  const names = new Set([...before.items.map((i) => i.name), ...after.items.map((i) => i.name)]);
  for (const name of names) {
    const delta = countItem(after, name) - countItem(before, name);
    if (delta < 0) removed[name] = -delta;
    else if (delta > 0) added[name] = delta;
  }
  return { removed, added };
}

/**
 * Verifies a transfer by requiring the sender to lose at least the expected amounts,
 * and (when observable) the receiver to gain them.
 */
export function verifyTransfer(
  expected: ItemRequirement[],
  senderBefore: InventorySummary,
  senderAfter: InventorySummary,
  receiverBefore: InventorySummary | null,
  receiverAfter: InventorySummary | null,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const senderDiff = diffInventory(senderBefore, senderAfter);
  for (const requirement of expected) {
    const name = normalizeItemName(requirement.item);
    const lost = senderDiff.removed[name] ?? 0;
    if (lost < requirement.count) {
      reasons.push(`sender lost ${lost}/${requirement.count} ${name}`);
    }
    if (receiverBefore && receiverAfter) {
      const gained = diffInventory(receiverBefore, receiverAfter).added[name] ?? 0;
      if (gained < requirement.count)
        reasons.push(`receiver gained ${gained}/${requirement.count} ${name}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
