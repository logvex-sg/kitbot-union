import { loadConfig, ConfigError } from '@unionkitbot/config';
import { createLogger, AgentClient } from '@unionkitbot/shared';
import { UnionKitDiscord } from './bot.js';
import { wireNotifications } from './notifications.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      console.error(`configuration error: ${error.issues.join('; ')}`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ name: 'discord', level: config.LOG_LEVEL });

  if (!config.DISCORD_TOKEN || !config.DISCORD_CLIENT_ID || !config.DISCORD_GUILD_ID) {
    // Discord is optional. Exit 0 so `restart: unless-stopped` leaves the container stopped
    // instead of hot-looping forever on a deployment that does not use the Discord controller.
    logger.warn(
      'DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID are not set; Discord controller disabled',
    );
    process.exit(0);
  }

  const agent = new AgentClient({
    url: process.env.AGENT_CONTROL_URL ?? 'ws://agent:8090',
    secret: config.API_SECRET,
    logger,
    onEvent: (event) => notify(event),
    source: 'discord',
  });

  const discord = new UnionKitDiscord({
    token: config.DISCORD_TOKEN,
    clientId: config.DISCORD_CLIENT_ID,
    guildId: config.DISCORD_GUILD_ID,
    notifyChannelId: config.DISCORD_NOTIFY_CHANNEL_ID ?? null,
    permissions: {
      allowedUserIds: config.discordAllowedUsers,
      allowedRoleIds: config.discordAllowedRoles,
      allowReadOnlyForEveryone: false,
    },
    agent,
    logger,
  });

  const notify = wireNotifications(discord);

  agent.connect();
  await discord.start();
  logger.info('UnionKitBot discord controller started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down discord');
    await discord.stop().catch(() => undefined);
    agent.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('discord failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
