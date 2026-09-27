import {
  DeliveryError,
  ValidationError,
  isValidOrderTransition,
  normalizeItemName,
  parseOrderCode,
  sleep,
  type AgentSettings,
  type ItemRequirement,
  type Logger,
  type OrderRecord,
  type OrderState,
  type OrderStatus,
  type ReservationLedger,
  type TaskExecutionContext,
  type Vec3,
} from '@unionkitbot/shared';
import type {
  AccountLinkRepository,
  KitRepository,
  OrderRepository,
  StorageMappingRepository,
} from '@unionkitbot/database';
import type { AgentEventEmitter } from '../events.js';
import type { Navigator } from '../navigation/navigator.js';
import type { InventoryService } from '../inventory/service.js';
import type { DeliveryService } from '../delivery/delivery-service.js';
import type { TpaRequester } from '../delivery/tpa-requester.js';

/** Why an order stopped. Distinguishes operator action from genuine failure. */
export type OrderFailureKind = 'validation' | 'delivery' | 'tpa' | 'navigation' | 'internal';

export class OrderError extends Error {
  readonly kind: OrderFailureKind;
  constructor(message: string, kind: OrderFailureKind = 'internal') {
    super(message);
    this.name = 'OrderError';
    this.kind = kind;
  }
}

export interface OrderServiceOptions {
  botId: string;
  username: string;
  server: string;
  logger: Logger;
  events: AgentEventEmitter;
  getSettings: () => AgentSettings;
  inventory: InventoryService;
  navigator: Navigator;
  delivery: DeliveryService;
  tpa: TpaRequester;
  reservations: ReservationLedger;
  kits: KitRepository;
  orders: OrderRepository;
  storageMappings: StorageMappingRepository;
  accountLinks: AccountLinkRepository;
  isConnected: () => boolean;
  /** Reports the order currently being executed, for death records and diagnostics. */
  onOrderActive?: (orderId: string) => void;
  onOrderFinished?: (orderId: string) => void;
}

export interface CreateOrderInput {
  kitIds: string[];
  recipient?: string | null;
  discordUserId?: string | null;
  requestedBy: string;
  source: OrderRecord['source'];
  code?: number;
}

export interface OrderOutcome {
  orderId: string;
  code: number;
  state: OrderState;
  status: OrderStatus;
  recipient: string | null;
  deliveryId: string | null;
  error?: string;
}

/**
 * Executes the order lifecycle end to end.
 *
 * The happy path is the explicit chain
 *   ORDER_RECEIVED -> VALIDATING -> RESERVING_ITEMS -> NAVIGATING_TO_TPA_POINT
 *   -> REQUESTING_TPA -> WAITING_FOR_TPA -> TELEPORT_WAIT -> LOCATING_PLAYER
 *   -> DELIVERING -> VERIFYING_DELIVERY -> RETURNING_TO_PACK_AREA -> COMPLETED
 *
 * Every transition goes through `advance`, which refuses an illegal move and persists the
 * new state, so a crash leaves the order in a state the resume path understands. Failure at
 * any step releases the item reservation and marks the order FAILED, which is the same
 * recovery surface the rest of the agent already uses.
 */
export class OrderService {
  private readonly options: OrderServiceOptions;

  constructor(options: OrderServiceOptions) {
    this.options = options;
  }

  private get settings(): AgentSettings {
    return this.options.getSettings();
  }

  /**
   * Persists a state transition, refusing an illegal one.
   *
   * A refused transition is a bug in the caller rather than a runtime condition, so it is
   * raised loudly instead of being silently absorbed.
   */
  private async advance(
    order: OrderRecord,
    next: OrderState,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    if (order.state !== next && !isValidOrderTransition(order.state, next)) {
      throw new OrderError(`illegal order transition ${order.state} -> ${next}`, 'internal');
    }
    const status: OrderStatus =
      next === 'COMPLETED'
        ? 'COMPLETED'
        : next === 'FAILED'
          ? 'FAILED'
          : next === 'CANCELLED'
            ? 'CANCELLED'
            : next === 'ORDER_RECEIVED'
              ? 'PENDING'
              : 'IN_PROGRESS';
    await this.options.orders.update(order.id, { state: next, status });
    await this.options.orders.appendState(order.id, next, detail);
    order.state = next;
    order.status = status;
    this.options.events.emit(
      'bot:order',
      `order ${order.code} -> ${next}`,
      { orderId: order.id, code: order.code, state: next, ...detail },
      { botId: this.options.botId },
    );
  }

  /** Resolves the Minecraft recipient for an order from either an explicit name or a link. */
  async resolveRecipient(
    input: Pick<CreateOrderInput, 'recipient' | 'discordUserId'>,
  ): Promise<{ username: string | null; uuid: string | null; reason: string }> {
    if (input.discordUserId) {
      const links = await this.options.accountLinks.forDiscordUser(input.discordUserId);
      const verified = links.find((link) => link.verified);
      if (verified) {
        return {
          username: verified.minecraftUsername,
          uuid: verified.minecraftUuid,
          reason: `resolved from linked Discord account ${input.discordUserId}`,
        };
      }
      if (links.length > 0) {
        return {
          username: null,
          uuid: null,
          reason: 'the linked Minecraft account is awaiting confirmation',
        };
      }
      if (!input.recipient) {
        return {
          username: null,
          uuid: null,
          reason: `Discord user ${input.discordUserId} has no linked Minecraft account`,
        };
      }
    }
    if (input.recipient) {
      return { username: input.recipient, uuid: null, reason: 'recipient supplied explicitly' };
    }
    return { username: null, uuid: null, reason: 'no recipient resolved' };
  }

  /**
   * Creates an order row and records the items it requires.
   *
   * Validation happens in `run`, but the row is created first so an order that is rejected
   * still leaves a durable record rather than only a transient error message.
   */
  async create(input: CreateOrderInput): Promise<OrderRecord> {
    const kits = await this.options.kits.list();
    const recipient = await this.resolveRecipient(input);

    const order = await this.options.orders.create({
      botId: this.options.botId,
      kitIds: input.kitIds,
      recipientUsername: recipient.username,
      recipientUuid: recipient.uuid,
      discordUserId: input.discordUserId ?? null,
      requestedBy: input.requestedBy,
      source: input.source,
      ...(input.code !== undefined ? { code: input.code } : {}),
    });

    await this.options.orders.setItems(order.id, mergeKitItems(kits, input.kitIds));
    return order;
  }

  /** Stock physically present in the bot's inventory. */
  private snapshotStock(): ItemRequirement[] {
    const summary = this.options.inventory.summary();
    if (!summary) return [];
    return summary.items.map((item) => ({ item: item.name, count: item.count }));
  }

  /**
   * Runs the order. This is the body of the ORDER task handler.
   *
   * `taskId` is recorded on the order so a restart can correlate the two, and every step
   * writes its progress into `setResumeState` so the queue's persisted resume state shows
   * exactly where the order stopped.
   */
  async run(
    orderId: string,
    ctx: Pick<TaskExecutionContext, 'token' | 'setResumeState'> & { taskId?: string },
  ): Promise<OrderOutcome> {
    const order = await this.options.orders.get(orderId);
    if (!order) throw new OrderError(`order ${orderId} not found`, 'validation');
    if (ctx.taskId) await this.options.orders.update(order.id, { taskId: ctx.taskId });
    this.options.onOrderActive?.(order.id);

    try {
      await this.advance(order, 'VALIDATING');

      const kits = await this.options.kits.list();
      const requirements = mergeKitItems(kits, order.kitIds);
      const validation = validateAgainstStock({
        kitIds: order.kitIds,
        kits,
        stock: this.snapshotStock(),
        reservedByOthers: this.options.reservations.reservedByOthers(
          this.options.botId,
          requirements,
          order.id,
        ),
        recipient: order.recipientUsername,
      });
      if (!validation.ok) throw new OrderError(validation.message, 'validation');

      await this.options.orders.setItems(order.id, requirements);
      ctx.setResumeState({ orderId: order.id, code: order.code, step: 'VALIDATING' });

      // ---------------------------------------------------- RESERVING_ITEMS
      await this.advance(order, 'RESERVING_ITEMS', { items: requirements.length });
      const reservation = this.options.reservations.reserve({
        orderId: order.id,
        botId: this.options.botId,
        items: requirements,
      });
      if (!reservation) {
        throw new OrderError('items could not be reserved; another order holds them', 'validation');
      }
      await this.options.orders.reserve(order.id, this.options.botId, requirements);
      ctx.setResumeState({ step: 'RESERVING_ITEMS' });

      const recipient = order.recipientUsername;
      if (!recipient) throw new OrderError('order has no recipient', 'validation');

      const attemptId = await this.options.orders.createAttempt({
        orderId: order.id,
        botId: this.options.botId,
        attempt: 1,
        recipient,
        phase: 'NAVIGATING_TO_TPA_POINT',
        items: requirements,
        dropRange: this.settings.delivery.dropRange,
        teleportWaitMs: this.settings.outgoingTpa.teleportWaitSeconds * 1000,
        detail: { kitIds: order.kitIds },
      });

      // ------------------------------------------- NAVIGATING_TO_TPA_POINT
      await this.advance(order, 'NAVIGATING_TO_TPA_POINT');
      ctx.setResumeState({ step: 'NAVIGATING_TO_TPA_POINT', recipient });

      // ----------------------------------------------------- REQUESTING_TPA
      await this.advance(order, 'REQUESTING_TPA', { recipient });
      ctx.setResumeState({ step: 'REQUESTING_TPA' });
      await this.options.orders.updateAttempt(attemptId, {
        phase: 'REQUESTING_TPA',
        tpaOutcome: 'PENDING',
      });

      if (!this.settings.outgoingTpa.enabled) {
        throw new OrderError('outgoing tpa is disabled but the order requires it', 'tpa');
      }
      if (!this.options.isConnected()) {
        throw new OrderError('bot is not connected; cannot request a teleport', 'tpa');
      }

      // ------------------------------------------------------ WAITING_FOR_TPA
      const tpaResult = await this.options.tpa.request(recipient, ctx.token);
      await this.options.orders.updateAttempt(attemptId, {
        phase: 'WAITING_FOR_TPA',
        tpaOutcome: tpaResult.outcome,
        detail: { tpaAttempts: tpaResult.attempts, tpaReason: tpaResult.reason },
      });
      if (tpaResult.outcome !== 'ACCEPTED') {
        throw new OrderError(
          `teleport request ${tpaResult.outcome.toLowerCase()}: ${tpaResult.reason}`,
          'tpa',
        );
      }
      await this.advance(order, 'WAITING_FOR_TPA', { outcome: tpaResult.outcome });

      // -------------------------------------------------------- TELEPORT_WAIT
      // The server teleports after a delay it controls, so the bot waits rather than
      // searching for the recipient while still in transit.
      await this.advance(order, 'TELEPORT_WAIT', {
        seconds: this.settings.outgoingTpa.teleportWaitSeconds,
      });
      ctx.setResumeState({
        step: 'TELEPORT_WAIT',
        seconds: this.settings.outgoingTpa.teleportWaitSeconds,
      });
      await this.waitForTeleport(ctx);
      await this.options.orders.updateAttempt(attemptId, { phase: 'TELEPORT_WAIT' });

      // ------------------------------------------------------- LOCATING_PLAYER
      await this.advance(order, 'LOCATING_PLAYER');
      ctx.setResumeState({ step: 'LOCATING_PLAYER' });
      const located = await this.locateRecipient(recipient, ctx);
      if (!located.ok) {
        throw new OrderError(`could not locate ${recipient}: ${located.reason}`, 'delivery');
      }
      await this.options.orders.updateAttempt(attemptId, { phase: 'LOCATING_PLAYER' });

      // ------------------------------------------------------------ DELIVERING
      await this.advance(order, 'DELIVERING');
      ctx.setResumeState({ step: 'DELIVERING' });
      const delivery = await this.options.delivery.deliver(
        {
          recipient,
          kitIds: order.kitIds,
          ...(located.position ? { destination: located.position } : {}),
        },
        { token: ctx.token, setResumeState: ctx.setResumeState, taskId: ctx.taskId },
      );
      await this.options.orders.update(order.id, { deliveryId: delivery.deliveryId });
      await this.options.orders.updateAttempt(attemptId, {
        phase: 'DELIVERING',
        verified: delivery.status === 'COMPLETED',
        detail: { deliveryId: delivery.deliveryId },
      });
      if (delivery.status !== 'COMPLETED') {
        throw new OrderError(delivery.error ?? 'delivery failed', 'delivery');
      }

      // ---------------------------------------------------- VERIFYING_DELIVERY
      await this.advance(order, 'VERIFYING_DELIVERY', { deliveryId: delivery.deliveryId });
      ctx.setResumeState({ step: 'VERIFYING_DELIVERY' });
      if (!delivery.verified) {
        throw new OrderError('delivery was not verified against inventory', 'delivery');
      }
      await this.options.orders.updateAttempt(attemptId, {
        phase: 'VERIFYING_DELIVERY',
        verified: true,
      });

      // ------------------------------------------------- RETURNING_TO_PACK_AREA
      await this.advance(order, 'RETURNING_TO_PACK_AREA');
      ctx.setResumeState({ step: 'RETURNING_TO_PACK_AREA' });
      const returned = await this.returnToPackArea();
      if (!returned.ok) {
        // Returning home is housekeeping; the order is already satisfied, so a failed
        // return is recorded without failing the order.
        this.options.logger.warn(
          { reason: returned.reason, order: order.code },
          'could not return to the pack area after delivery',
        );
      }

      // ------------------------------------------------------------ COMPLETED
      // Reserved items are consumed permanently only once the delivery is verified.
      await this.options.orders.settleReservations(order.id, 'CONSUMED');
      this.options.reservations.release(order.id);
      await this.advance(order, 'COMPLETED', { deliveryId: delivery.deliveryId });
      await this.options.orders.update(order.id, { error: null });

      await this.executePostDelivery();

      this.options.onOrderFinished?.(order.id);
      return {
        orderId: order.id,
        code: order.code,
        state: 'COMPLETED',
        status: 'COMPLETED',
        recipient,
        deliveryId: delivery.deliveryId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof OrderError ? error.kind : 'internal';
      // A failed or cancelled delivery leaves an outstanding TPA waiter behind; clear it so
      // the next order is not refused with "another tpa request is outstanding".
      this.options.tpa.cancel();
      await this.fail(order, message, kind);
      this.options.onOrderFinished?.(order.id);
      return {
        orderId: order.id,
        code: order.code,
        state: 'FAILED',
        status: 'FAILED',
        recipient: order.recipientUsername,
        deliveryId: order.deliveryId,
        error: message,
      };
    }
  }

  /** Marks an order FAILED and releases its reservation so the stock is usable again. */
  private async fail(order: OrderRecord, message: string, kind: OrderFailureKind): Promise<void> {
    await this.options.orders.update(order.id, { error: message, status: 'FAILED' });
    await this.options.orders.settleReservations(order.id, 'RELEASED');
    this.options.reservations.release(order.id);
    await this.options.orders
      .appendState(order.id, 'FAILED', { error: message, kind })
      .catch((error: unknown) =>
        this.options.logger.debug({ err: error }, 'failed to append failure state'),
      );
    order.state = 'FAILED';
    order.status = 'FAILED';
    this.options.events.emit(
      'bot:error',
      `order ${order.code} failed: ${message}`,
      { orderId: order.id, code: order.code, kind, error: message },
      { botId: this.options.botId, severity: 'error' },
    );
  }

  /** Cancels an order, releasing its reservation. Safe on an already-terminal order. */
  async cancel(orderId: string, reason = 'cancelled by operator'): Promise<boolean> {
    const order = await this.options.orders.get(orderId);
    if (!order) return false;
    if (order.status === 'COMPLETED' || order.status === 'CANCELLED') return false;
    await this.options.orders.update(order.id, { error: reason, status: 'CANCELLED' });
    await this.options.orders.settleReservations(order.id, 'RELEASED');
    this.options.reservations.release(order.id);
    await this.options.orders
      .appendState(order.id, 'CANCELLED', { reason })
      .catch((error: unknown) =>
        this.options.logger.debug({ err: error }, 'failed to append cancel state'),
      );
    this.options.tpa.cancel();
    this.options.events.emit(
      'bot:order',
      `order ${order.code} cancelled: ${reason}`,
      { orderId: order.id, code: order.code, reason },
      { botId: this.options.botId, severity: 'warn' },
    );
    return true;
  }

  /**
   * Replays durable reservations into the in-memory ledger after a restart.
   *
   * Without this a restarted agent would believe the stock was free and could promise the
   * same items to a second order.
   */
  async restoreReservations(): Promise<number> {
    const held = await this.options.orders.listHeldReservations(this.options.botId);
    const byOrder = new Map<string, ItemRequirement[]>();
    for (const row of held) {
      const orderId = String(row['orderId']);
      const list = byOrder.get(orderId) ?? [];
      list.push({ item: normalizeItemName(String(row['item'])), count: Number(row['count']) });
      byOrder.set(orderId, list);
    }
    for (const [orderId, items] of byOrder) {
      this.options.reservations.hydrate({
        id: orderId,
        orderId,
        botId: this.options.botId,
        items,
        at: new Date().toISOString(),
      });
    }
    return byOrder.size;
  }

  /** Waits out the server's teleport delay, aborting early if the task is cancelled. */
  private async waitForTeleport(ctx: Pick<TaskExecutionContext, 'token'>): Promise<void> {
    const seconds = this.settings.outgoingTpa.teleportWaitSeconds;
    if (seconds <= 0) return;
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      ctx.token.throwIfCancelled();
      await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
    }
  }

  /**
   * Finds the recipient and reports their position once they are visible.
   *
   * The recipient must be online and loaded before items can be handed over; a missing
   * entity is reported rather than treated as an empty position.
   */
  private async locateRecipient(
    recipient: string,
    ctx: Pick<TaskExecutionContext, 'token'>,
  ): Promise<{ ok: boolean; reason: string; position: Vec3 | null }> {
    const deadline = Date.now() + this.settings.delivery.verifyTimeoutMs;
    for (;;) {
      ctx.token.throwIfCancelled();
      if (!this.options.isConnected()) return { ok: false, reason: 'disconnected', position: null };
      const entity = this.options.navigator.findPlayer(recipient);
      if (entity) {
        return {
          ok: true,
          reason: 'recipient visible',
          position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        };
      }
      if (Date.now() > deadline) {
        return { ok: false, reason: 'recipient is not online or not visible', position: null };
      }
      await sleep(500);
    }
  }

  /**
   * Navigates back to the configured pack/storage area.
   *
   * The destination is a storage mapping configured as the pack area, resolved through the
   * same navigator the rest of the agent uses, so the return trip does not block the queue
   * any longer than any other navigation.
   */
  private async returnToPackArea(): Promise<{ ok: boolean; reason: string }> {
    const pack = this.settings.packArea;
    if (!pack?.waypointName) return { ok: true, reason: 'no pack area configured' };
    const mappings = await this.options.storageMappings.list({
      botId: this.options.botId,
      limit: 200,
    });
    const target = mappings.find((m) => m.groupKey === pack.waypointName);
    if (!target) {
      return { ok: true, reason: `pack area ${pack.waypointName} is not currently mapped` };
    }
    const result = await this.options.navigator.gotoCoordinates(
      { x: target.x, y: target.y, z: target.z },
      `pack area ${pack.waypointName}`,
    );
    return { ok: result.ok, reason: result.reason };
  }

  /**
   * Runs the configured post-delivery command.
   *
   * Disabled by default and only ever sends the operator's own configured command. Nothing
   * received from Discord is executed here: the command comes from this bot's settings.
   */
  private async executePostDelivery(): Promise<void> {
    const post = this.settings.delivery.postDelivery;
    if (!post.enabled) return;
    if (!post.command || post.command.trim().length === 0) return;
    if (!this.options.isConnected()) return;
    try {
      this.options.events.emit(
        'bot:log',
        'running post-delivery command',
        { command: post.command },
        { botId: this.options.botId },
      );
      await this.options.delivery.runConfiguredCommand(post.command);
    } catch (error) {
      this.options.logger.warn({ err: error }, 'post-delivery command failed');
    }
  }
}

export interface KitLike {
  id: string;
  name: string;
  enabled?: boolean;
  items: ItemRequirement[];
}

/** Flattens the items of the requested kits, merging duplicates. */
export function mergeKitItems(
  kits: readonly KitLike[],
  kitIds: readonly string[],
): ItemRequirement[] {
  const byId = new Map(kits.map((kit) => [kit.id, kit]));
  const totals = new Map<string, number>();
  for (const kitId of kitIds) {
    const kit = byId.get(kitId);
    if (!kit) continue;
    for (const item of kit.items) {
      const name = normalizeItemName(item.item);
      totals.set(name, (totals.get(name) ?? 0) + item.count);
    }
  }
  return [...totals.entries()].map(([item, count]) => ({ item, count }));
}

/**
 * Validates an order against current stock and other orders' reservations.
 *
 * Kept separate from the service so the same rules can be unit tested and reused by the API
 * to pre-flight an order before it is created.
 */
export function validateAgainstStock(input: {
  kitIds: readonly string[];
  kits: readonly KitLike[];
  stock: readonly ItemRequirement[];
  reservedByOthers: readonly ItemRequirement[];
  recipient: string | null;
}): { ok: true } | { ok: false; message: string } {
  const byId = new Map(input.kits.map((kit) => [kit.id, kit]));
  for (const kitId of input.kitIds) {
    const kit = byId.get(kitId);
    if (!kit) return { ok: false, message: `unknown kit: ${kitId}` };
    if (kit.enabled === false) return { ok: false, message: `kit is disabled: ${kitId}` };
  }
  if (!input.recipient) {
    return { ok: false, message: 'no Minecraft account is linked to this order' };
  }

  const required = mergeKitItems(input.kits, input.kitIds);
  if (required.length === 0) return { ok: false, message: 'order resolved to no items' };

  const reserved = new Map(
    input.reservedByOthers.map((r) => [normalizeItemName(r.item), r.count] as const),
  );
  const available = new Map(
    input.stock.map((s) => {
      const name = normalizeItemName(s.item);
      return [name, Math.max(0, s.count - (reserved.get(name) ?? 0))] as const;
    }),
  );
  const shortfall = required
    .map((req) => {
      const name = normalizeItemName(req.item);
      const have = available.get(name) ?? 0;
      return { item: name, count: Math.max(0, req.count - have) };
    })
    .filter((req) => req.count > 0);

  if (shortfall.length > 0) {
    return {
      ok: false,
      message: `not enough available: ${shortfall.map((s) => `${s.count}x ${s.item}`).join(', ')}`,
    };
  }
  return { ok: true };
}

export { parseOrderCode, DeliveryError, ValidationError };
