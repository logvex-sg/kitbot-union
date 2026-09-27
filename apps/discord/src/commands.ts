import { SlashCommandBuilder } from 'discord.js';

/**
 * Slash command definitions. Every command maps onto a CommandRouter action on the agent,
 * so there is no Discord-only write path into Minecraft.
 */
export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('bot')
    .setDescription('UnionKitBot control and status')
    .addSubcommand((sc) =>
      sc
        .setName('status')
        .setDescription('Show bot status')
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('start')
        .setDescription('Start a bot')
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('stop')
        .setDescription('Stop a bot')
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('restart')
        .setDescription('Restart a bot')
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('goto')
        .setDescription('Navigate to coordinates')
        .addNumberOption((o) => o.setName('x').setDescription('X').setRequired(true))
        .addNumberOption((o) => o.setName('y').setDescription('Y').setRequired(true))
        .addNumberOption((o) => o.setName('z').setDescription('Z').setRequired(true))
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('follow')
        .setDescription('Follow a player')
        .addStringOption((o) => o.setName('player').setDescription('Player name').setRequired(true))
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('inventory')
        .setDescription('Show bot inventory')
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('players')
        .setDescription('List visible players')
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('tasks')
        .setDescription('List tasks')
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('deliver')
        .setDescription('Queue a kit delivery')
        .addStringOption((o) => o.setName('player').setDescription('Recipient').setRequired(true))
        .addStringOption((o) =>
          o.setName('kits').setDescription('Comma-separated kit ids').setRequired(false),
        )
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('scan')
        .setDescription('Scan storage around a position')
        .addNumberOption((o) => o.setName('x').setDescription('X').setRequired(false))
        .addNumberOption((o) => o.setName('y').setDescription('Y').setRequired(false))
        .addNumberOption((o) => o.setName('z').setDescription('Z').setRequired(false))
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('order')
        .setDescription('Queue a kit order for a recipient')
        .addStringOption((o) => o.setName('player').setDescription('Recipient').setRequired(true))
        .addStringOption((o) =>
          o.setName('kits').setDescription('Comma-separated kit ids').setRequired(false),
        )
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('orders')
        .setDescription('List recent orders')
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('cancelorder')
        .setDescription('Cancel an order by code')
        .addIntegerOption((o) => o.setName('code').setDescription('Order code').setRequired(true))
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('mappings')
        .setDescription('List kit storage sign mappings')
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('setmapping')
        .setDescription('Override the kit detected for a storage group')
        .addStringOption((o) =>
          o.setName('group').setDescription('Storage group key').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('kit').setDescription('Kit id, or "-" to clear').setRequired(true),
        )
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('webhook')
        .setDescription('Show webhook configuration (URL is redacted)')
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('say')
        .setDescription('Send a Minecraft chat message')
        .addStringOption((o) => o.setName('message').setDescription('Message').setRequired(true))
        .addStringOption((o) => o.setName('bot').setDescription('Bot name').setRequired(false)),
    ),
].map((builder) => builder.toJSON());
