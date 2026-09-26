import type { Bot } from 'mineflayer';
import {
  buildInventorySummary,
  countItem,
  missingRequirements,
  type InventorySummary,
  type ItemRequirement,
} from '@unionkitbot/shared';

export class InventoryService {
  constructor(private readonly getBot: () => Bot | null) {}

  /** Reads only data the client actually has; empty slots are excluded. */
  summary(): InventorySummary | null {
    const bot = this.getBot();
    if (!bot) return null;
    const slots = bot.inventory.slots.map((item, index) => ({
      slot: index,
      name: item?.name ?? null,
      count: item?.count ?? 0,
      ...(item?.displayName ? { displayName: item.displayName } : {}),
    }));
    const totalSlots = bot.inventory.slots.length - 5;
    return buildInventorySummary(slots, Math.max(totalSlots, 36));
  }

  count(item: string): number {
    const summary = this.summary();
    if (!summary) return 0;
    return countItem(summary, item);
  }

  missing(requirements: ItemRequirement[]): ItemRequirement[] {
    const summary = this.summary();
    if (!summary) return requirements;
    return missingRequirements(summary, requirements);
  }

  /** Drops items by name until `count` remain. Used only when explicitly requested. */
  async drop(item: string, count: number): Promise<number> {
    const bot = this.getBot();
    if (!bot) return 0;
    let remaining = count;
    let dropped = 0;
    for (const slot of bot.inventory.slots) {
      if (remaining <= 0) break;
      if (!slot || slot.name !== item) continue;
      const amount = Math.min(slot.count, remaining);
      await bot.toss(slot.type, null, amount);
      remaining -= amount;
      dropped += amount;
    }
    return dropped;
  }

  /** Equips an item from inventory (e.g. holding a tool while delivering). */
  async equip(item: string): Promise<boolean> {
    const bot = this.getBot();
    if (!bot) return false;
    const found = bot.inventory.items().find((i) => i.name === item);
    if (!found) return false;
    await bot.equip(found, 'hand');
    return true;
  }
}
