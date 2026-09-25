import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@unionkitbot/shared': r('./packages/shared/src/index.ts'),
      '@unionkitbot/schemas': r('./packages/schemas/src/index.ts'),
      '@unionkitbot/config': r('./packages/config/src/index.ts'),
      '@unionkitbot/database': r('./packages/database/src/index.ts'),
      '@unionkitbot/agent/commands': r('./apps/agent/src/commands.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
  },
});
