import type { Bot } from 'mineflayer';
import {
  DeliveryError,
  formatContainerCounts,
  kitRequirements,
  normalizeItemName,
  sleep,
  type DeliveryStep,
  type InventorySummary,
  type ItemRequirement,
  type Logger,
  type TaskExecutionContext,
  type Vec3,
} from '@unionkitbot/shared';
import type { DeliveryRepository, KitRepository, StorageRepository } from '@unionkitbot/database';
import type { AgentEventEmitter } from '../events.js';
import type { Navigator } from '../navigation/navigator.js';
import type { InventoryService } from '../inventory/service.js';
import type { StorageScanner } from '../storage/scanner.js';
import type { WaypointService } from '../waypoints/service.js';

export interface DeliveryRequest {
  recipient: string;
  kitIds: string[];
  destination?: Vec3;
  scanRadius?: number;
  note?: string;
}

export interface DeliveryOutcome {
  deliveryId: string;
  status: 'COMPLETED' | 'FAILED';
  steps: DeliveryStep[];
  verified: boolean;
  verification: Record<string, unknown>;
  scan: { scanId: string; logicalContainerCount: number; counts: Record<string, number> } | null;
  waypointId: string | null;
  error?: string;
}

export interface DeliveryServiceOptions {
  botId: string;
  username: string;
  logger: Logger;
  events: AgentEventEmitter;
  getBot: () => Bot | null;
  navigator: Navigator;
  inventory: InventoryService;
  scanner: StorageScanner;
  waypoints: WaypointService;
  kits: KitRepository;
  deliveries: DeliveryRepository;
  storage: StorageRepository;
  getDimension: () => string;
  /** Distance the bot stops at before transferring items. */
  approachDistance: number;
  verifyTimeoutMs: number;
}

/**
 * Executes the delivery pipeline step by step. Delivery is never assumed to have
 * succeeded: the recipient inventory is re-read and the transfer is verified before
 * the delivery is marked COMPLETED.
 */
export class DeliveryService {
  private readonly options: DeliveryServiceOptions;

  constructor(options: DeliveryServiceOptions) {
    this.options = options;
  }

  private step(deliveryId: string, step: DeliveryStep, detail: Record<string, unknown> = {}): void {
    this.options.events.emit(
      'bot:delivery',
      `delivery step ${step}`,
      {
        deliveryId,
        step,
        ...detail,
      },
      { botId: this.options.botId },
    );
  }

  async deliver(
    request: DeliveryRequest,
    ctx: Pick<TaskExecutionContext, 'token' | 'setResumeState'> & { taskId?: string },
  ): Promise<DeliveryOutcome> {
    const steps: DeliveryStep[] = [];
    const mark = (step: DeliveryStep, detail: Record<string, unknown> = {}): void => {
      steps.push(step);
      ctx.setResumeState({
        deliveryStep: step,
        recipient: request.recipient,
        kitIds: request.kitIds,
      });
      this.step(deliveryId, step, detail);
    };

    const kits = await this.options.kits.list();
    const expected: ItemRequirement[] = kitRequirements(kits, request.kitIds);

    const delivery = await this.options.deliveries.create({
      botId: this.options.botId,
      recipient: request.recipient,
      kitIds: request.kitIds,
      taskId: ctx.taskId ?? null,
      destination: request.destination ?? null,
    });
    const deliveryId = delivery.id;
    mark('CREATE_TASK', { kits: request.kitIds });

    let scanResult: DeliveryOutcome['scan'] = null;
    let waypointId: string | null = null;
    let verification: Record<string, unknown> = {};

    try {
      ctx.token.throwIfCancelled();
      await this.options.deliveries.update(deliveryId, {
        status: 'IN_PROGRESS',
        currentStep: 'CHECK_INVENTORY',
      });

      // CHECK_INVENTORY
      const senderBefore = this.options.inventory.summary();
      if (!senderBefore) throw new DeliveryError('cannot read bot inventory while disconnected');
      const missing = this.options.inventory.missing(expected);
      mark('CHECK_INVENTORY', { hasAll: missing.length === 0, missing, expected });
      if (missing.length > 0) {
        throw new DeliveryError(
          `bot inventory is missing ${missing.map((m) => `${m.count}x ${m.item}`).join(', ')}`,
          { missing },
        );
      }

      // FIND_RECIPIENT
      const bot = this.options.getBot();
      if (!bot) throw new DeliveryError('bot disconnected before recipient lookup');
      const recipientEntity = this.options.navigator.findPlayer(request.recipient);
      mark('FIND_RECIPIENT', { found: recipientEntity !== null });
      if (!recipientEntity && !request.destination) {
        throw new DeliveryError(`recipient ${request.recipient} is not online or not visible`);
      }

      // NAVIGATE
      const destination: Vec3 = request.destination ?? {
        x: recipientEntity!.position.x,
        y: recipientEntity!.position.y,
        z: recipientEntity!.position.z,
      };
      const nav = await this.options.navigator.gotoCoordinates(
        destination,
        `delivery to ${request.recipient}`,
      );
      ctx.token.throwIfCancelled();
      mark('NAVIGATE', { ok: nav.ok, reason: nav.reason, destination, replans: nav.replans });
      if (!nav.ok) throw new DeliveryError(`navigation failed: ${nav.reason}`);

      mark('ARRIVE', { position: nav.finalPosition });

      // VERIFY_RECIPIENT - the recipient must still be nearby before we hand anything over.
      const verified = await this.waitForRecipient(destination, ctx);
      mark('VERIFY_RECIPIENT', { ok: verified.ok, reason: verified.reason });
      if (!verified.ok)
        throw new DeliveryError(`recipient verification failed: ${verified.reason}`);

      // DELIVER - drop the items at the recipient's feet, which is what a vanilla
      // server sees as a legitimate transfer.
      const delivered = await this.transferItems(expected, ctx);
      mark('DELIVER', { delivered });

      // VERIFY_DELIVERY - re-read inventory and confirm the sender actually lost the items.
      const senderAfter = this.options.inventory.summary();
      if (!senderAfter) throw new DeliveryError('bot disconnected during verification');
      const transferCheck = verifySenderLoss(senderBefore, senderAfter, expected);
      verification = {
        senderBefore: summarizeForEvidence(senderBefore),
        senderAfter: summarizeForEvidence(senderAfter),
        expected,
        ...transferCheck,
      };
      mark('VERIFY_DELIVERY', { ok: transferCheck.ok, reasons: transferCheck.reasons });
      if (!transferCheck.ok) {
        throw new DeliveryError(
          `delivery verification failed: ${transferCheck.reasons.join('; ')}`,
          {
            verification,
          },
        );
      }

      // SCAN_AREA
      const radius = request.scanRadius ?? 8;
      const scan = await this.options.scanner.scan(destination, {
        radius,
        inspectContents: true,
      });
      await this.options.storage.saveScan(scan.result, deliveryId, scan.contents);
      scanResult = {
        scanId: scan.result.scanId,
        logicalContainerCount: scan.result.logicalContainerCount,
        counts: scan.result.counts,
      };
      mark('SCAN_AREA', {
        scanId: scan.result.scanId,
        logicalContainerCount: scan.result.logicalContainerCount,
        counts: scan.result.counts,
      });

      // CREATE_WAYPOINT
      const waypoint = await this.options.waypoints.create({
        name: `delivery ${request.recipient} ${new Date().toISOString()}`,
        type: 'DELIVERY',
        dimension: this.options.getDimension(),
        x: destination.x,
        y: destination.y,
        z: destination.z,
        metadata: {
          recipient: request.recipient,
          kitIds: request.kitIds,
          deliveryId,
          scanId: scan.result.scanId,
          logicalContainerCount: scan.result.logicalContainerCount,
        },
      });
      waypointId = waypoint.id;
      mark('CREATE_WAYPOINT', { waypointId });

      // SAVE_RESULT
      await this.options.deliveries.update(deliveryId, {
        status: 'COMPLETED',
        currentStep: 'COMPLETE',
        verified: true,
        verification,
        result: {
          steps,
          scan: scanResult,
          waypointId,
          delivered,
        },
        completedAt: new Date(),
      });
      mark('SAVE_RESULT', { status: 'COMPLETED' });
      mark('DISCORD_REPORT', { status: 'COMPLETED' });
      mark('COMPLETE');

      this.options.events.emit(
        'bot:delivery',
        `delivery to ${request.recipient} completed`,
        {
          deliveryId,
          status: 'COMPLETED',
          recipient: request.recipient,
          kitIds: request.kitIds,
          scanSummary: formatContainerCounts(scan.result.counts),
          logicalContainerCount: scan.result.logicalContainerCount,
        },
        { botId: this.options.botId },
      );

      return {
        deliveryId,
        status: 'COMPLETED',
        steps,
        verified: true,
        verification,
        scan: scanResult,
        waypointId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.deliveries.update(deliveryId, {
        status: 'FAILED',
        currentStep: steps[steps.length - 1] ?? 'CREATE_TASK',
        verified: false,
        verification,
        error: message,
        completedAt: new Date(),
      });
      this.options.events.emit(
        'bot:delivery',
        `delivery to ${request.recipient} failed: ${message}`,
        {
          deliveryId,
          status: 'FAILED',
          recipient: request.recipient,
          steps,
          error: message,
        },
        { botId: this.options.botId, severity: 'error' },
      );
      return {
        deliveryId,
        status: 'FAILED',
        steps,
        verified: false,
        verification,
        scan: scanResult,
        waypointId,
        error: message,
      };
    }
  }

  /** Polls for the recipient until they are within `approachDistance`. */
  private async waitForRecipient(
    destination: Vec3,
    ctx: Pick<TaskExecutionContext, 'token'>,
  ): Promise<{ ok: boolean; reason: string }> {
    const deadline = Date.now() + this.options.verifyTimeoutMs;
    for (;;) {
      ctx.token.throwIfCancelled();
      const bot = this.options.getBot();
      if (!bot) return { ok: false, reason: 'disconnected' };
      const position = bot.entity.position;
      const dx = position.x - destination.x;
      const dz = position.z - destination.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance <= this.options.approachDistance + 2) {
        return { ok: true, reason: `within ${distance.toFixed(1)} blocks` };
      }
      if (Date.now() > deadline)
        return { ok: false, reason: `still ${distance.toFixed(1)} blocks away` };
      await sleep(500);
    }
  }

  /** Tosses the required items near the recipient. Returns per-item delivered counts. */
  private async transferItems(
    expected: ItemRequirement[],
    ctx: Pick<TaskExecutionContext, 'token'>,
  ): Promise<Record<string, number>> {
    const bot = this.options.getBot();
    if (!bot) throw new DeliveryError('bot disconnected during transfer');
    const delivered: Record<string, number> = {};
    for (const requirement of expected) {
      ctx.token.throwIfCancelled();
      const name = normalizeItemName(requirement.item);
      let remaining = requirement.count;
      delivered[name] = 0;
      for (const slot of [...bot.inventory.slots]) {
        if (remaining <= 0) break;
        if (!slot || normalizeItemName(slot.name) !== name) continue;
        const amount = Math.min(slot.count, remaining);
        await bot.toss(slot.type, null, amount);
        remaining -= amount;
        delivered[name] += amount;
        await sleep(150);
      }
      if (remaining > 0) {
        throw new DeliveryError(
          `could not transfer full amount of ${name}: ${remaining} remaining`,
          { delivered },
        );
      }
    }
    // Give the server a moment to process the entity spawns before verification.
    await sleep(600);
    return delivered;
  }

  /** Exposed for the API/UI/Discord so a delivery can be inspected on demand. */
  async list(limit = 50): Promise<unknown[]> {
    return this.options.deliveries.list({ botId: this.options.botId, limit });
  }
}

export function verifySenderLoss(
  before: InventorySummary,
  after: InventorySummary,
  expected: ItemRequirement[],
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const requirement of expected) {
    const name = normalizeItemName(requirement.item);
    const beforeCount = before.items
      .filter((i) => i.name === name)
      .reduce((s, i) => s + i.count, 0);
    const afterCount = after.items.filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
    const lost = beforeCount - afterCount;
    if (lost < requirement.count) {
      reasons.push(`expected to lose ${requirement.count} ${name} but lost ${lost}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function summarizeForEvidence(summary: InventorySummary): { usedSlots: number; items: number } {
  return { usedSlots: summary.usedSlots, items: summary.items.length };
}
