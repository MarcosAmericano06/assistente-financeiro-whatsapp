import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // cada arquivo cria o próprio banco no Postgres do docker compose
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
