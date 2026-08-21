import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'esnext',
    // two entries (§I raft/app, §V.81): the pirate sim and the raft share
    // modules and nothing else — `npm run dev` serves both
    rollupOptions: {
      input: { main: 'index.html', raft: 'raft.html' },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
