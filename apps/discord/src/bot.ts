import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { createLogger, type AgentEvent, type Logger } from '@unionkitbot/shared';
import type { AgentClient } from '@unionkitbot/shared';
import { canExecute, type PermissionConfig } from './permissions.js';
import { commandDefinitions } from './commands.js';

export interface DiscordOptions {
  token: string;
  clientId: string;
  guildId: string;
  notifyChannelId: string | null;
  permissions: PermissionConfig;
  agent: AgentClient;
  logger?: Logger;
}

const ERROR_SEVERITY = new Set(['error', 'critical']);

/**
 * Discord controller. It authenticates as an official bot application (never a self-bot),
 * enforces role/user permissions, forwards commands to the agent and mirrors Minecraft
 * events into a notification channel.
 */
export class UnionKitDiscord {
  private readonly client: Client;
  private readonly logger: Logger;
  private readonly options: DiscordOptions;
  private readonly recentEvents: AgentEvent[] = [];

  constructor(options: DiscordOptions) {
    this.options = options;
    this.logger = options.logger ?? createLogger({ name: 'discord' });
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    });
    this.client.once(Events.ClientReady, () => {
      this.logger.info({ user: this.client.user?.tag }, 'discord bot ready');
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteraction(interaction);
    });
  }

  async start(): Promise<void> {
    await this.registerCommands();
    await this.client.login(this.options.token);
  }

  private async registerCommands(): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(this.options.token);
    try {
      await rest.put(Routes.applicationGuildCommands(this.options.clientId, this.options.guildId), {
        body: commandDefinitions,
      });
      this.logger.info('guild slash commands registered');
    } catch (error) {
      this.logger.error({ err: error }, 'failed to register slash commands');
      throw error;
    }
  }

  /** Mirrors a runtime event into the notification channel, filtering noise. */
  async handleAgentEvent(event: AgentEvent): Promise<void> {
    this.recentEvents.push(event);
    if (this.recentEvents.length > 200) this.recentEvents.shift();

    const notable = new Set([
      'bot:connected',
      'bot:disconnected',
      'bot:reconnecting',
      'bot:death',
      'bot:tpa',
      'bot:delivery',
      'bot:storage-scan',
      'bot:waypoint',
      'bot:error',
    ]);
    if (!notable.has(event.type)) return;
    if (event.type === 'bot:heartbeat') return;

    const isError = ERROR_SEVERITY.has(event.severity);
    const embed = new EmbedBuilder()
      .setTitle(event.type)
      .setDescription(event.message.slice(0, 4000))
      .setTimestamp(new Date(event.at))
      .setColor(isError ? 0xd9534f : 0x5aa469);
    if (event.botId) embed.addFields({ name: 'Bot', value: event.botId, inline: true });

    await this.sendNotification({ embeds: [embed] });
  }

  private async sendNotification(
    payload: { embeds: EmbedBuilder[] } | { content: string },
  ): Promise<void> {
    if (!this.options.notifyChannelId) return;
    try {
      const channel = await this.client.channels.fetch(this.options.notifyChannelId);
      if (channel && channel.isTextBased() && 'send' in channel) {
        await channel.send(payload as never);
      }
    } catch (error) {
      this.logger.debug({ err: error }, 'failed to send discord notification');
    }
  }

  private async onInteraction(interaction: unknown): Promise<void> {
    const candidate = interaction as ChatInputCommandInteraction;
    if (!candidate.isChatInputCommand || !candidate.isChatInputCommand()) return;
    if (candidate.commandName !== 'bot') return;

    const sub = candidate.options.getSubcommand(true);
    const member = candidate.member as GuildMember | null;
    const decision = canExecute(sub, member, this.options.permissions);
    if (!decision.allowed) {
      await candidate.reply({
        content: `You are not permitted to run \`/bot ${sub}\`: ${decision.reason}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await candidate.deferReply();
    try {
      const result = await this.dispatch(sub, candidate);
      const body = result.message.length > 0 ? result.message : '(no output)';
      await candidate.editReply({
        content: body.length > 1900 ? `${body.slice(0, 1900)}\n…truncated` : body,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'command failed';
      await candidate.editReply({ content: `error: ${message}`, allowedMentions: { parse: [] } });
    }
  }

  private async dispatch(
    sub: string,
    interaction: ChatInputCommandInteraction,
  ): Promise<{ ok: boolean; message: string }> {
    const bot = interaction.options.getString('bot') ?? undefined;
    const stringOpt = (name: string): string | null => interaction.options.getString(name);
    const numberOpt = (name: string): number | null => interaction.options.getNumber(name);

    switch (sub) {
      case 'status':
        return this.options.agent.send('status', [], bot, interaction.user.id);
      case 'start':
        return this.options.agent.send('start', [], bot, interaction.user.id);
      case 'stop':
        return this.options.agent.send('stop', [], bot, interaction.user.id);
      case 'restart':
        return this.options.agent.send('restart', [], bot, interaction.user.id);
      case 'goto': {
        const x = numberOpt('x');
        const y = numberOpt('y');
        const z = numberOpt('z');
        if (x === null || y === null || z === null)
          return { ok: false, message: 'x, y and z are required' };
        return this.options.agent.send(
          'goto',
          [String(x), String(y), String(z)],
          bot,
          interaction.user.id,
        );
      }
      case 'follow': {
        const player = stringOpt('player');
        if (!player) return { ok: false, message: 'player is required' };
        return this.options.agent.send('follow', [player], bot, interaction.user.id);
      }
      case 'inventory':
        return this.options.agent.send('inventory', [], bot, interaction.user.id);
      case 'players':
        return this.options.agent.send('players', [], bot, interaction.user.id);
      case 'tasks':
        return this.options.agent.send('tasks', [], bot, interaction.user.id);
      case 'deliver': {
        const player = stringOpt('player');
        if (!player) return { ok: false, message: 'player is required' };
        const kits = stringOpt('kits');
        const args = [
          player,
          ...(kits
            ? kits
                .split(',')
                .map((k) => k.trim())
                .filter(Boolean)
            : []),
        ];
        return this.options.agent.send('deliver', args, bot, interaction.user.id);
      }
      case 'scan': {
        const x = numberOpt('x');
        const y = numberOpt('y');
        const z = numberOpt('z');
        const args =
          x !== null && y !== null && z !== null ? [String(x), String(y), String(z)] : [];
        return this.options.agent.send('scan', args, bot, interaction.user.id);
      }
      case 'order': {
        const player = stringOpt('player');
        if (!player) return { ok: false, message: 'player is required' };
        const kits = stringOpt('kits');
        const args = [
          player,
          ...(kits
            ? kits
                .split(',')
                .map((k) => k.trim())
                .filter(Boolean)
            : []),
        ];
        return this.options.agent.send('order', args, bot, interaction.user.id);
      }
      case 'orders':
        return this.options.agent.send('orders', [], bot, interaction.user.id);
      case 'cancelorder': {
        const code = interaction.options.getInteger('code');
        if (code === null) return { ok: false, message: 'code is required' };
        return this.options.agent.send('cancelorder', [String(code)], bot, interaction.user.id);
      }
      case 'mappings':
        return this.options.agent.send('storagemappings', [], bot, interaction.user.id);
      case 'setmapping': {
        const group = stringOpt('group');
        const kit = stringOpt('kit');
        if (!group || !kit) return { ok: false, message: 'group and kit are required' };
        return this.options.agent.send('setmapping', [group, kit], bot, interaction.user.id);
      }
      case 'webhook':
        return this.options.agent.send('webhook', ['show'], bot, interaction.user.id);
      case 'say': {
        const message = stringOpt('message');
        if (!message) return { ok: false, message: 'message is required' };
        return this.options.agent.send('say', [message], bot, interaction.user.id);
      }
      default:
        return { ok: false, message: `unknown subcommand ${sub}` };
    }
  }

  recent(limit = 20): AgentEvent[] {
    return this.recentEvents.slice(-limit);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}

export { PermissionFlagsBits };
