import { randomUUID } from 'node:crypto';
import type { ItemRequirement } from './types.js';
import type { Logger } from './logger.js';
import { normalizeItemName } from './inventory.js';
import { ValidationError } from './errors.js';

/**
 * Order lifecycle. Orders are the operator-facing unit of work; a delivery task is what
 * the bot executes to satisfy one.
 *
 * The happy path is linear and each failure maps onto the existing recovery/error
 * mechanisms rather than inventing a parallel retry system.
 */
export const ORDER_STATES = [
  'ORDER_RECEIVED',
  'VALIDATING',
  'RESERVING_ITEMS',
  'NAVIGATING_TO_TPA_POINT',
  'REQUESTING_TPA',
  'WAITING_FOR_TPA',
  'TELEPORT_WAIT',
  'LOCATING_PLAYER',
  'DELIVERING',
  'VERIFYING_DELIVERY',
  'RETURNING_TO_PACK_AREA',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const ORDER_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Terminal states release reservations; COMPLETED additionally consumes them. */
export const TERMINAL_ORDER_STATES: readonly OrderState[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

export const ORDER_STATE_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  ORDER_RECEIVED: ['VALIDATING', 'FAILED', 'CANCELLED'],
  VALIDATING: ['RESERVING_ITEMS', 'FAILED', 'CANCELLED'],
  RESERVING_ITEMS: ['NAVIGATING_TO_TPA_POINT', 'FAILED', 'CANCELLED'],
  NAVIGATING_TO_TPA_POINT: ['REQUESTING_TPA', 'FAILED', 'CANCELLED'],
  REQUESTING_TPA: ['WAITING_FOR_TPA', 'FAILED', 'CANCELLED'],
  WAITING_FOR_TPA: ['TELEPORT_WAIT', 'FAILED', 'CANCELLED'],
  TELEPORT_WAIT: ['LOCATING_PLAYER', 'FAILED', 'CANCELLED'],
  LOCATING_PLAYER: ['DELIVERING', 'FAILED', 'CANCELLED'],
  DELIVERING: ['VERIFYING_DELIVERY', 'FAILED', 'CANCELLED'],
  VERIFYING_DELIVERY: ['RETURNING_TO_PACK_AREA', 'FAILED', 'CANCELLED'],
  RETURNING_TO_PACK_AREA: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isValidOrderTransition(from: OrderState, to: OrderState): boolean {
  if (from === to) return true;
  return ORDER_STATE_TRANSITIONS[from].includes(to);
}

export function isTerminalOrderState(state: OrderState): boolean {
  return TERMINAL_ORDER_STATES.includes(state);
}

export interface OrderRecord {
  id: string;
  botId: string;
  /** Numeric short code operators type, e.g. `/order 1`. */
  code: number;
  kitIds: string[];
  state: OrderState;
  status: OrderStatus;
  /** Linked Minecraft recipient resolved from the Discord account link. */
  recipientUsername: string | null;
  recipientUuid: string | null;
  discordUserId: string | null;
  requestedBy: string;
  source: 'discord' | 'api' | 'chat' | 'cli';
  taskId: string | null;
  deliveryId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationRequest {
  orderId: string;
  botId: string;
  items: ItemRequirement[];
}

export interface Reservation {
  id: string;
  orderId: string;
  botId: string;
  items: ItemRequirement[];
  at: string;
}

/**
 * In-memory reservation ledger guarding a bot's stock.
 *
 * The queue already guarantees one delivery runs at a time, but reservations stop a
 * *queued* order from promising the same items to two recipients: without them, order 2
 * can pass its inventory check while order 1 is still in flight, and then fail at the
 * drop because order 1 consumed the stock.
 *
 * Available = physical stock - sum(reservations held by other orders).
 * Lifetime is the process; the authoritative record is the `order_reservations` table,
 * which is replayed into this ledger after a restart.
 */
export class ReservationLedger {
  private readonly reservations = new Map<string, Reservation>();

  /**
   * `events` is optional so the ledger can also be constructed in isolation by tests and
   * by code paths that only need the arithmetic. When present, a refused reservation is
   * reported, which is what makes an inventory conflict visible in the operator UI.
   */
  constructor(
    private readonly options: {
      botId?: string;
      logger?: Logger;
      events?: { emit: (type: 'bot:task', message: string, data: unknown, options?: { botId?: string | null; severity?: 'info' | 'warn' | 'error' }) => unknown };
    } = {},
  ) {}

  /** Items reserved by orders other than `orderId`. */
  reservedByOthers(botId: string, items: readonly ItemRequirement[], orderId: string): ItemRequirement[] {
    const totals = new Map<string, number>();
    for (const reservation of this.reservations.values()) {
      if (reservation.botId !== botId) continue;
      if (reservation.orderId === orderId) continue;
      for (const item of reservation.items) {
        const name = normalizeItemName(item.item);
        totals.set(name, (totals.get(name) ?? 0) + item.count);
      }
    }
    return [...totals.entries()].map(([item, count]) => ({ item, count }));
  }

  /**
   * Attempts to reserve `items` for an order.
   *
   * @returns the reservation, or `null` when the request is already reserved by another
   *          order (the caller must treat that as "not enough available").
   */
  reserve(input: ReservationRequest): Reservation | null {
    if (this.reservations.has(input.orderId)) {
      return this.reservations.get(input.orderId)!;
    }
    const conflicting = this.conflicts(input.orderId, input.botId, input.items);
    if (conflicting.length > 0) {
      this.options.events?.emit(
        'bot:task',
        `cannot reserve ${conflicting.map((c) => `${c.count}x ${c.item}`).join(', ')}: held by another order`,
        { orderId: input.orderId, conflicts: conflicting },
        { botId: input.botId, severity: 'warn' },
      );
      return null;
    }
    const reservation: Reservation = {
      id: randomUUID(),
      orderId: input.orderId,
      botId: input.botId,
      items: mergeRequirements(input.items),
      at: new Date().toISOString(),
    };
    this.reservations.set(input.orderId, reservation);
    return reservation;
  }

  /**
   * Which of `items` are already claimed by a *different* order for the same bot.
   *
   * Physical stock is checked separately against inventory; this guard exists so two orders
   * queued at the same moment cannot both reserve the same items before either ships.
   */
  conflicts(
    orderId: string,
    botId: string,
    items: readonly ItemRequirement[],
  ): ItemRequirement[] {
    const held = new Map(
      this.reservedByOthers(botId, items, orderId).map((r) => [normalizeItemName(r.item), r.count] as const),
    );
    return items
      .map((item) => {
        const name = normalizeItemName(item.item);
        const taken = held.get(name) ?? 0;
        return { item: name, count: Math.min(item.count, taken) };
      })
      .filter((c) => c.count > 0);
  }

  /** Re-registers a persisted reservation after a process restart. */
  hydrate(reservation: Reservation): void {
    this.reservations.set(reservation.orderId, {
      ...reservation,
      items: mergeRequirements(reservation.items),
    });
  }

  release(orderId: string): boolean {
    return this.reservations.delete(orderId);
  }

  get(orderId: string): Reservation | undefined {
    return this.reservations.get(orderId);
  }

  list(botId?: string): Reservation[] {
    const all = [...this.reservations.values()];
    return botId ? all.filter((r) => r.botId === botId) : all;
  }

  clear(): void {
    this.reservations.clear();
  }
}

export function mergeRequirements(items: readonly ItemRequirement[]): ItemRequirement[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    const name = normalizeItemName(item.item);
    totals.set(name, (totals.get(name) ?? 0) + item.count);
  }
  return [...totals.entries()].map(([item, count]) => ({ item, count }));
}

/**
 * Computes what is genuinely available to a new order: physical stock minus everything
 * already promised to other orders.
 *
 * A negative result is clamped to zero rather than reported as negative stock, because a
 * negative figure is meaningless to an operator and would confuse the shortfall message.
 */
export function availableRequirements(
  stock: readonly ItemRequirement[],
  reservedByOthers: readonly ItemRequirement[],
): ItemRequirement[] {
  const reserved = new Map(
    reservedByOthers.map((r) => [normalizeItemName(r.item), r.count] as const),
  );
  return stock.map((item) => {
    const name = normalizeItemName(item.item);
    const free = Math.max(0, item.count - (reserved.get(name) ?? 0));
    return { item: name, count: free };
  });
}

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface OrderValidationInput {
  order: { kitIds: string[] };
  kits: ReadonlyArray<{ id: string; name: string; enabled?: boolean; items: ItemRequirement[] }>;
  /** Items physically present in the bot's inventory. */
  stock: readonly ItemRequirement[];
  /** Items promised to other in-flight orders. */
  reservedByOthers?: readonly ItemRequirement[];
  recipientUsername: string | null;
  requireRecipient?: boolean;
}

/**
 * Validates an order before any resource is committed.
 *
 * Ordered checks: kit exists -> kit enabled -> recipient resolvable -> enough available
 * stock. Everything that can be rejected without touching the bot is rejected here, so a
 * bad order never reaches the queue.
 */
export function validateOrder(input: OrderValidationInput): {
  ok: boolean;
  issues: ValidationIssue[];
  requirements: ItemRequirement[];
  shortfall: ItemRequirement[];
} {
  const issues: ValidationIssue[] = [];
  const byId = new Map(input.kits.map((kit) => [kit.id, kit]));

  if (input.order.kitIds.length === 0) {
    issues.push({ code: 'no_kits', message: 'order must request at least one kit' });
  }
  const seen = new Set<string>();
  for (const kitId of input.order.kitIds) {
    if (seen.has(kitId)) {
      issues.push({ code: 'duplicate_kit', message: `kit ${kitId} requested more than once` });
      continue;
    }
    seen.add(kitId);
    const kit = byId.get(kitId);
    if (!kit) {
      issues.push({ code: 'unknown_kit', message: `unknown kit: ${kitId}` });
      continue;
    }
    if (kit.enabled === false) {
      issues.push({ code: 'kit_disabled', message: `kit is disabled: ${kitId}` });
    }
  }

  if ((input.requireRecipient ?? true) && !input.recipientUsername) {
    issues.push({
      code: 'no_recipient',
      message: 'no Minecraft account is linked to this order',
    });
  }

  let requirements: ItemRequirement[] = [];
  let shortfall: ItemRequirement[] = [];
  if (issues.length === 0) {
    requirements = mergeRequirements(
      input.order.kitIds.flatMap((kitId) => byId.get(kitId)?.items ?? []),
    );
    const available = mergeRequirements(
      availableRequirements(input.stock, input.reservedByOthers ?? []),
    );
    const availableMap = new Map(available.map((a) => [normalizeItemName(a.item), a.count]));
    shortfall = requirements
      .map((req) => {
        const have = availableMap.get(normalizeItemName(req.item)) ?? 0;
        return { item: normalizeItemName(req.item), count: Math.max(0, req.count - have) };
      })
      .filter((req) => req.count > 0);
    if (shortfall.length > 0) {
      issues.push({
        code: 'insufficient_stock',
        message: `not enough available: ${shortfall
          .map((s) => `${s.count}x ${s.item}`)
          .join(', ')}`,
      });
    }
  }

  return { ok: issues.length === 0, issues, requirements, shortfall };
}

/** Parses an order code from operator input such as `/order 1`. */
export function parseOrderCode(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError('order code must be a positive integer', { raw });
  }
  return value;
}
