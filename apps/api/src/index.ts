import { buildServer } from './server.js';
import { loadConfig, ConfigError } from '@unionkitbot/config';

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

  const server = await buildServer({ config });
  await server.app.listen({ port: config.API_PORT, host: config.API_HOST });
  server.logger.info({ port: config.API_PORT }, 'UnionKitBot API listening');

  const shutdown = async (signal: string): Promise<void> => {
    server.logger.info({ signal }, 'shutting down api');
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('api failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
