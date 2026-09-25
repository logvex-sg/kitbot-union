export const BOT_STATES = [
  'OFFLINE',
  'CONNECTING',
  'SPAWNING',
  'IDLE',
  'NAVIGATING',
  'DELIVERING',
  'SCANNING',
  'RECOVERING',
  'DISCONNECTED',
  'DEAD',
  'ERROR',
] as const;
export type BotState = (typeof BOT_STATES)[number];

export const TASK_PRIORITIES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

export const TASK_TYPES = [
  'CONNECT',
  'RECONNECT',
  'DEATH_RECOVERY',
  'TPA_HANDLING',
  'DELIVERY',
  'NAVIGATE',
  'FOLLOW',
  'INVENTORY',
  'STORAGE_SCAN',
  'STATISTICS',
  'TELEMETRY',
  'CHAT_REPLY',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = [
  'PENDING',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TPA_MODES = [
  'DISABLED',
  'TRUSTED_ONLY',
  'ALLOW_LIST',
  'MANUAL',
  'CUSTOM_RULES',
] as const;
export type TpaMode = (typeof TPA_MODES)[number];

export const WAYPOINT_TYPES = ['DELIVERY', 'DEATH', 'STORAGE', 'TARGET', 'BASE', 'CUSTOM'] as const;
export type WaypointType = (typeof WAYPOINT_TYPES)[number];

export const CHAT_EVENT_TYPES = [
  'TPA_REQUEST',
  'DELIVERY_REQUEST',
  'GREETING',
  'SERVER_MESSAGE',
  'DEATH',
  'DISCONNECT',
  'UNKNOWN',
] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export const DELIVERY_STEPS = [
  'CREATE_TASK',
  'CHECK_INVENTORY',
  'FIND_RECIPIENT',
  'NAVIGATE',
  'ARRIVE',
  'VERIFY_RECIPIENT',
  'DELIVER',
  'VERIFY_DELIVERY',
  'SCAN_AREA',
  'CREATE_WAYPOINT',
  'SAVE_RESULT',
  'DISCORD_REPORT',
  'COMPLETE',
] as const;
export type DeliveryStep = (typeof DELIVERY_STEPS)[number];

export const DELIVERY_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const CONTAINER_KINDS = [
  'CHEST',
  'DOUBLE_CHEST',
  'BARREL',
  'SHULKER_BOX',
  'TRAPPED_CHEST',
  'ENDER_CHEST',
] as const;
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface BotPosition extends Vec3 {
  yaw?: number;
  pitch?: number;
  dimension: string;
}
export interface ItemRequirement {
  item: string;
  count: number;
}

export interface KitDefinition {
  id: string;
  name: string;
  description?: string;
  items: ItemRequirement[];
  enabled?: boolean;
}

export interface InventorySlotSummary {
  name: string;
  displayName?: string;
  count: number;
  slot: number;
}
export interface InventorySummary {
  usedSlots: number;
  totalSlots: number;
  items: InventorySlotSummary[];
  emptySlots: number;
}

export interface ContainerRecord {
  kind: ContainerKind;
  x: number;
  y: number;
  z: number;
  blockName: string;
  groupKey: string;
}

export interface StorageScanResult {
  scanId: string;
  botId: string;
  dimension: string;
  origin: Vec3;
  radius: number;
  timestamp: string;
  containers: ContainerRecord[];
  counts: Record<string, number>;
  logicalContainerCount: number;
  inspected: number;
}

export interface TpaSettings {
  enabled: boolean;
  mode: TpaMode;
  timeoutMs: number;
  trustedPlayers: string[];
  blockedPlayers: string[];
  customRules: Record<string, boolean>;
  cooldownMs: number;
  maxPending: number;
}

export interface TpaDecision {
  requestId: string;
  player: string;
  playerUuid: string | null;
  accepted: boolean;
  mode: TpaMode;
  reason: string;
  at: string;
}

export interface ChatEventRecord {
  id: string;
  botId: string;
  raw: string;
  eventType: ChatEventType;
  player: string | null;
  message: string;
  metadata: Record<string, unknown>;
  at: string;
}

export interface ParsedChat {
  eventType: ChatEventType;
  player: string | null;
  coordinates: Vec3 | null;
  payload: Record<string, unknown>;
  confidence: number;
}

export interface BotRuntimeSnapshot {
  botId: string;
  username: string;
  server: string;
  state: BotState;
  connected: boolean;
  position: BotPosition | null;
  health: number | null;
  food: number | null;
  dimension: string;
  uptimeMs: number;
  reconnectCount: number;
  currentTaskId: string | null;
  currentTaskType: TaskType | null;
  target: string | null;
  pathfinding: string | null;
  inventory: InventorySummary | null;
  lastHeartbeat: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  version?: string;
  auth: 'offline' | 'microsoft';
  username: string;
  password?: string;
  authmePassword?: string;
}

export interface AgentSettings {
  reconnect: { baseDelayMs: number; maxDelayMs: number; maxAttempts: number; jitter: boolean };
  navigation: {
    goalRadius: number;
    pathTimeoutMs: number;
    stuckCheckIntervalMs: number;
    stuckThreshold: number;
    replanCooldownMs: number;
  };
  storage: { scanRadius: number; inspectContents: boolean };
  chat: { respondToGreetings: boolean; greetingMessage: string; responseCooldownMs: number };
  delivery: { approachDistance: number; verifyTimeoutMs: number; maxRetries: number };
  tpa: TpaSettings;
}

export interface PriorityTask<T = unknown> {
  id: string;
  botId: string;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  payload: T;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  result: unknown;
  resumeState: Record<string, unknown>;
}

export interface AuditEntry {
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
}
