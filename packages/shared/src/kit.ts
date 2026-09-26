import type { ItemRequirement, KitDefinition } from './types.js';
import { ValidationError } from './errors.js';
import { normalizeItemName } from './inventory.js';

/** Validates and normalises an untrusted kit definition. Throws ValidationError. */
export function validateKit(kit: unknown): KitDefinition {
  if (!kit || typeof kit !== 'object') throw new ValidationError('kit must be an object');
  const candidate = kit as Partial<KitDefinition>;
  if (!candidate.id || typeof candidate.id !== 'string')
    throw new ValidationError('kit.id is required');
  if (!candidate.name || typeof candidate.name !== 'string')
    throw new ValidationError('kit.name is required');
  if (!Array.isArray(candidate.items) || candidate.items.length === 0) {
    throw new ValidationError('kit.items must be a non-empty array');
  }
  const items: ItemRequirement[] = candidate.items.map((item, index) => {
    if (!item || typeof item !== 'object')
      throw new ValidationError(`items[${index}] must be an object`);
    const raw = item as Partial<ItemRequirement>;
    if (!raw.item || typeof raw.item !== 'string')
      throw new ValidationError(`items[${index}].item is required`);
    if (typeof raw.count !== 'number' || !Number.isInteger(raw.count) || raw.count <= 0) {
      throw new ValidationError(`items[${index}].count must be a positive integer`);
    }
    return { item: normalizeItemName(raw.item), count: raw.count };
  });
  const merged = new Map<string, number>();
  for (const item of items) merged.set(item.item, (merged.get(item.item) ?? 0) + item.count);
  return {
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    items: [...merged.entries()].map(([item, count]) => ({ item, count })),
    enabled: candidate.enabled ?? true,
  };
}

/** Flattens the item requirements of several kits, validating each exists and is enabled. */
export function kitRequirements(kits: KitDefinition[], kitIds: string[]): ItemRequirement[] {
  const byId = new Map(kits.map((k) => [k.id, k]));
  const totals = new Map<string, number>();
  for (const id of kitIds) {
    const kit = byId.get(id);
    if (!kit) throw new ValidationError(`unknown kit: ${id}`);
    if (kit.enabled === false) throw new ValidationError(`kit is disabled: ${id}`);
    for (const item of kit.items) totals.set(item.item, (totals.get(item.item) ?? 0) + item.count);
  }
  return [...totals.entries()].map(([item, count]) => ({ item, count }));
}
