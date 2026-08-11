import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'esnext',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
