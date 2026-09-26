import { parseGotoArgs, type Vec3 } from '@unionkitbot/shared';
import type { BotRuntime } from './runtime.js';
import type { BotRegistry } from './registry.js';

export interface CommandResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

export type CommandSource = 'api' | 'discord' | 'console';

export interface CommandRequest {
  command: string;
  args: string[];
  /** Explicit bot name/id; falls back to the first registered bot. */
  bot?: string;
  source: CommandSource;
  actor: string;
}

/**
 * Single command router shared by the REST API, WebSocket control channel and the Discord
 * bot, so every entry point resolves to the same runtime behaviour and audit trail.
 */
export class CommandRouter {
  constructor(
    private readonly registry: BotRegistry,
    private readonly audit: (entry: {
      actor: string;
      action: string;
      targetType: string | null;
      targetId: string | null;
      detail: Record<string, unknown>;
    }) => Promise<void>,
  ) {}

  resolve(bot?: string): BotRuntime | undefined {
    if (!bot) return this.registry.first();
    return this.registry.get(bot) ?? this.registry.getByName(bot) ?? this.registry.first();
  }

  /**
   * A bot created through the API exists in PostgreSQL before the agent process knows about
   * it, so the in-memory registry can be stale. Re-read the definitions on a miss to pick up
   * bots added since startup; `register` is idempotent, so existing runtimes are untouched.
   */
  private async resolveOrReload(bot?: string): Promise<BotRuntime | undefined> {
    if (!bot) return this.registry.first();
    const found = this.registry.get(bot) ?? this.registry.getByName(bot);
    if (found) return found;
    await this.registry.loadFromDatabase();
    return this.registry.get(bot) ?? this.registry.getByName(bot);
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    const runtime = await this.resolveOrReload(request.bot);
    const command = request.command.replace(/^\//, '').toLowerCase();

    await this.audit({
      actor: request.actor,
      action: `command:${command}`,
      targetType: 'bot',
      targetId: runtime?.definition.id ?? null,
      detail: { args: request.args, source: request.source, bot: request.bot ?? null },
    });

    if (!runtime && command !== 'bots' && command !== 'health') {
      return { ok: false, message: 'no bot instance available' };
    }

    switch (command) {
      case 'status':
        return { ok: true, message: await runtime!.statusText(), data: runtime!.snapshot() };

      case 'start':
        await runtime!.start();
        return { ok: true, message: `starting ${runtime!.definition.name}` };

      case 'stop':
        await runtime!.stop('stop command');
        return { ok: true, message: `stopped ${runtime!.definition.name}` };

      case 'restart':
        await runtime!.restart();
        return { ok: true, message: `restarting ${runtime!.definition.name}` };

      case 'reload': {
        // Called by the API after a bot definition is edited so the live runtime picks up the
        // new server address without an agent restart.
        if (!request.bot) return { ok: false, message: 'reload requires a bot name or id' };
        const reloaded = await this.registry.reload(runtime!.definition.id);
        if (!reloaded) return { ok: false, message: 'bot not found' };
        return { ok: true, message: `reloaded ${reloaded.definition.name}` };
      }

      case 'goto': {
        const target = this.parseCoordinates(request.args);
        if (!target) return { ok: false, message: 'usage: goto <x> <y> <z>' };
        const task = runtime!.enqueue(
          'NAVIGATE',
          'NORMAL',
          { target, label: 'manual goto' },
          'goto',
        );
        return {
          ok: true,
          message: `navigating to ${target.x}, ${target.y}, ${target.z}`,
          data: { taskId: task.id },
        };
      }

      case 'follow': {
        const player = request.args[0];
        if (!player) return { ok: false, message: 'usage: follow <player>' };
        const task = runtime!.enqueue('FOLLOW', 'NORMAL', { player }, `follow ${player}`);
        return { ok: true, message: `following ${player}`, data: { taskId: task.id } };
      }

      case 'stopnav':
      case 'stopnavigation':
        runtime!.navigator.cancel('stop command');
        return { ok: true, message: 'navigation cancelled' };

      case 'inventory':
        return {
          ok: true,
          message: this.formatInventory(runtime!),
          data: runtime!.inventory.summary(),
        };

      case 'players': {
        const players = runtime!.navigator.listPlayers();
        return {
          ok: true,
          message: players.length
            ? players
                .map(
                  (p) =>
                    `${p.username}${p.position ? ` @ ${p.position.x.toFixed(0)},${p.position.y.toFixed(0)},${p.position.z.toFixed(0)}` : ''}`,
                )
                .join('\n')
            : 'no players visible',
          data: players,
        };
      }

      case 'tasks': {
        const tasks = runtime!.listTasks();
        return {
          ok: true,
          message: tasks.length
            ? tasks
                .map((t) => `${t.status} ${t.priority} ${t.type} (${t.id.slice(0, 8)})`)
                .join('\n')
            : 'no tasks',
          data: tasks,
        };
      }

      case 'deliver': {
        const recipient = request.args[0];
        if (!recipient) return { ok: false, message: 'usage: deliver <player> [kitId ...]' };
        const kitIds = request.args.slice(1).filter((a) => a.length > 0);
        const task = runtime!.enqueue(
          'DELIVERY',
          'NORMAL',
          { recipient, kitIds: kitIds.length ? kitIds : ['starter'] },
          `deliver to ${recipient}`,
        );
        return {
          ok: true,
          message: `delivery to ${recipient} queued (${kitIds.length ? kitIds.join(', ') : 'starter'})`,
          data: { taskId: task.id },
        };
      }

      case 'scan': {
        const destination = this.parseCoordinates(request.args);
        const origin =
          destination ??
          (runtime!.snapshot().position
            ? {
                x: runtime!.snapshot().position!.x,
                y: runtime!.snapshot().position!.y,
                z: runtime!.snapshot().position!.z,
              }
            : null);
        if (!origin) return { ok: false, message: 'usage: scan <x> <y> <z> (or connect first)' };
        const task = runtime!.enqueue('STORAGE_SCAN', 'LOW', { origin }, 'manual scan');
        return { ok: true, message: 'storage scan queued', data: { taskId: task.id } };
      }

      case 'enqueue': {
        const [type, priority, payloadJson] = request.args;
        if (!type || !priority) {
          return { ok: false, message: 'usage: enqueue <type> <priority> [json]' };
        }
        let payload: unknown = {};
        if (payloadJson) {
          try {
            payload = JSON.parse(payloadJson);
          } catch {
            return { ok: false, message: 'payload must be valid JSON' };
          }
        }
        const task = runtime!.enqueue(type as never, priority as never, payload, 'api enqueue');
        return { ok: true, message: `task ${task.type} enqueued`, data: { taskId: task.id } };
      }

      case 'canceltask': {
        const id = request.args[0];
        if (!id) return { ok: false, message: 'usage: canceltask <taskId>' };
        return runtime!.cancelTask(id)
          ? { ok: true, message: `task ${id} cancelled` }
          : { ok: false, message: `task ${id} could not be cancelled` };
      }

      case 'pausetask': {
        const id = request.args[0];
        if (!id) return { ok: false, message: 'usage: pausetask <taskId>' };
        return runtime!.pauseTask(id)
          ? { ok: true, message: `task ${id} paused` }
          : { ok: false, message: `task ${id} could not be paused` };
      }

      case 'resumetask': {
        const id = request.args[0];
        if (!id) return { ok: false, message: 'usage: resumetask <taskId>' };
        return runtime!.resumeTask(id)
          ? { ok: true, message: `task ${id} resumed` }
          : { ok: false, message: `task ${id} could not be resumed` };
      }

      case 'tpa': {
        const player = request.args[0];
        const decision = (request.args[1] ?? '').toLowerCase();
        if (!player || !['accept', 'deny', 'reject'].includes(decision)) {
          return { ok: false, message: 'usage: tpa <player> <accept|deny>' };
        }
        const result = await runtime!.tpa.resolveManually(player, decision === 'accept');
        return {
          ok: true,
          message: `tpa from ${player} ${result.accepted ? 'accepted' : 'rejected'}`,
          data: result,
        };
      }

      case 'say': {
        const message = request.args.join(' ');
        if (!message) return { ok: false, message: 'usage: say <message>' };
        runtime!.chat.say(message);
        return { ok: true, message: 'sent' };
      }

      case 'bots':
        return {
          ok: true,
          message: this.registry
            .list()
            .map((r) => `${r.definition.name} (${r.definition.username}) ${r.snapshot().state}`)
            .join('\n'),
          data: this.registry.snapshots(),
        };

      case 'health':
        return {
          ok: true,
          message: `bots: ${this.registry.size}`,
          data: { bots: this.registry.size },
        };

      default:
        return { ok: false, message: `unknown command: ${command}` };
    }
  }

  private parseCoordinates(args: string[]): Vec3 | null {
    return parseGotoArgs(args);
  }

  private formatInventory(runtime: BotRuntime): string {
    const summary = runtime.inventory.summary();
    if (!summary) return 'inventory unavailable (not connected)';
    if (summary.items.length === 0) return 'inventory is empty';
    return summary.items.map((i) => `${i.count}x ${i.name}`).join('\n');
  }
}
