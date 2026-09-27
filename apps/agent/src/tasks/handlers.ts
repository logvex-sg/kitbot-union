import type { PriorityTask, TaskExecutionContext, Vec3 } from '@unionkitbot/shared';
import { NotConnectedError, ValidationError, isVec3 } from '@unionkitbot/shared';
import type { AgentContext } from '../types.js';

export type HandlerMap = Record<
  string,
  (task: PriorityTask, ctx: TaskExecutionContext) => Promise<unknown>
>;

/**
 * Task handlers implementing the OBSERVE -> DECIDE -> ACT -> VERIFY loop for each task
 * type. They are registered on the priority queue, so pause/cancel propagates through
 * the shared execution token.
 */
export function createTaskHandlers(context: AgentContext): HandlerMap {
  const requireBot = () => {
    const bot = context.getBot();
    if (!bot) throw new NotConnectedError();
    return bot;
  };

  return {
    CONNECT: async (task, ctx) => {
      ctx.setResumeState({ phase: 'connecting' });
      await context.connection.connect();
      return { state: context.connection.currentState };
    },

    RECONNECT: async (task, ctx) => {
      ctx.setResumeState({ phase: 'reconnecting' });
      if (context.connection.isConnected) {
        await context.connection.stop('reconnect task');
      }
      await context.connection.connect();
      return { state: context.connection.currentState };
    },

    NAVIGATE: async (task, _ctx) => {
      const payload = task.payload as { target?: Vec3; label?: string };
      if (!payload.target) throw new ValidationError('NAVIGATE requires payload.target');
      requireBot();
      return context.navigator.gotoCoordinates(payload.target, payload.label);
    },

    FOLLOW: async (task, _ctx) => {
      const payload = task.payload as { player?: string };
      if (!payload.player) throw new ValidationError('FOLLOW requires payload.player');
      requireBot();
      return context.navigator.followPlayer(payload.player);
    },

    INVENTORY: async () => {
      requireBot();
      return context.inventory.summary();
    },

    DELIVERY: async (task, ctx) => {
      const payload = task.payload as {
        recipient: string;
        kitIds: string[];
        destination?: Vec3;
        scanRadius?: number;
        note?: string;
      };
      requireBot();
      return context.delivery.deliver(payload, {
        token: ctx.token,
        setResumeState: ctx.setResumeState,
        taskId: task.id,
      });
    },

    STORAGE_SCAN: async (task, ctx) => {
      const payload = task.payload as {
        origin?: Vec3;
        radius?: number;
        detectSigns?: boolean;
      };
      const bot = requireBot();
      const origin = isVec3(payload.origin)
        ? payload.origin
        : {
            x: bot.entity.position.x,
            y: bot.entity.position.y,
            z: bot.entity.position.z,
          };
      const radius = payload.radius ?? context.settings.storage.scanRadius;
      const kits = await context.storageMappings.kits();
      ctx.setResumeState({ phase: 'scanning', origin, radius });
      const scan = await context.scanner.scan(origin, {
        radius,
        inspectContents: context.settings.storage.inspectContents,
        detectSigns: payload.detectSigns ?? context.settings.storage.signAutoDetect,
        signMaxDistance: context.settings.storage.signMaxDistance,
        kits,
        onRecognised: async (recognition) => {
          await context.storageMappings.record(recognition.recognised, scan.result.scanId);
        },
      });
      await context.storage.saveScan(scan.result, null, scan.contents);
      return {
        ...scan.result,
        recognised: scan.recognition
          ? {
              signsFound: scan.recognition.signsFound,
              kitsRecognised: scan.recognition.kitsRecognised,
              ambiguous: scan.recognition.ambiguous,
              unreadable: scan.recognition.unreadable,
            }
          : null,
      };
    },

    DEATH_RECOVERY: async (task, ctx) => {
      ctx.setResumeState({ phase: 'recovering' });
      if (!context.connection.isConnected) {
        await context.connection.connect();
      }
      const payload = task.payload as { deathEventId?: string };
      if (payload.deathEventId) await context.death.markRecovered(payload.deathEventId);
      return { recovered: true };
    },

    TPA_HANDLING: async (task) => {
      const payload = task.payload as { player: string; accept: boolean };
      if (!payload.player) throw new ValidationError('TPA_HANDLING requires payload.player');
      return { player: payload.player, accept: payload.accept };
    },

    CHAT_REPLY: async (task) => {
      const payload = task.payload as { message: string };
      if (!payload.message) throw new ValidationError('CHAT_REPLY requires payload.message');
      context.chat.say(payload.message);
      return { sent: payload.message };
    },

    STATISTICS: async () => {
      const bot = context.getBot();
      if (!bot) return { connected: false };
      return {
        position: {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z,
        },
        health: bot.health,
        food: bot.food,
        players: Object.keys(bot.players).length,
        inventory: context.inventory.summary(),
      };
    },

    TELEMETRY: async () => {
      await context.registry.publishSnapshot(context.botId);
      return { published: true };
    },

    /**
     * Executes a stored order.
     *
     * The payload carries the order id, which is the durable source of truth: the task is
     * only the trigger. If the task is retried after a restart the order resumes from the
     * state recorded in Postgres instead of starting over.
     */
    ORDER: async (task, ctx) => {
      const payload = task.payload as { orderId?: string };
      if (!payload.orderId) throw new ValidationError('ORDER requires payload.orderId');
      ctx.setResumeState({ orderId: payload.orderId, step: 'starting' });
      const outcome = await context.orders.run(payload.orderId, {
        token: ctx.token,
        setResumeState: ctx.setResumeState,
        taskId: task.id,
      });
      // A failed order has already been persisted and reported; surfacing it as a task error
      // would trigger a retry that cannot succeed until an operator intervenes.
      return outcome;
    },
  };
}
