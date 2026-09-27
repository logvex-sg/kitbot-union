import type { Bot } from 'mineflayer';
import type { AgentSettings, BotState, ReservationLedger, TpaEngineState } from '@unionkitbot/shared';
import type { StorageRepository } from '@unionkitbot/database';
import type { AgentEventEmitter } from './events.js';
import type { BotRegistry } from './registry.js';
import type { Navigator } from './navigation/navigator.js';
import type { DeliveryService } from './delivery/delivery-service.js';
import type { TpaRequester } from './delivery/tpa-requester.js';
import type { StorageScanner } from './storage/scanner.js';
import type { WaypointService } from './waypoints/service.js';
import type { ChatService } from './chat/service.js';
import type { InventoryService } from './inventory/service.js';
import type { DeathService } from './death/service.js';
import type { OrderService } from './orders/service.js';
import type { StorageMappingService } from './storage/mappings.js';
import type { MinecraftConnection } from './minecraft/connection.js';

/** Services every runtime task handler can rely on. */
export interface AgentContext {
  botId: string;
  events: AgentEventEmitter;
  settings: AgentSettings;
  connection: MinecraftConnection;
  navigator: Navigator;
  delivery: DeliveryService;
  scanner: StorageScanner;
  waypoints: WaypointService;
  chat: ChatService;
  inventory: InventoryService;
  death: DeathService;
  tpa: TpaEngineState;
  registry: BotRegistry;
  storage: StorageRepository;
  orders: OrderService;
  reservations: ReservationLedger;
  outgoingTpa: TpaRequester;
  storageMappings: StorageMappingService;
  getBot(): Bot | null;
  /** Current connection state, for handlers that must not start work while offline. */
  getState(): BotState;
}
