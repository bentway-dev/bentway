import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Multi-project config. Each @bentway package contributes a project whose
// `test/**/*.test.ts` files are run with the shared frozen-clock setup at
// the repo root. _harness.ts also lives at the repo root and is imported
// by relative path from packages/core/test/turn-loop.contract.test.ts.
const ROOT = dirname(fileURLToPath(import.meta.url));
const setupFile = resolve(ROOT, 'test/_setup.ts');

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: '@bentway/stream-json',
          root: resolve(ROOT, 'packages/stream-json'),
          include: ['test/**/*.test.ts'],
          setupFiles: [setupFile],
        },
      },
      {
        test: {
          name: '@bentway/core',
          root: resolve(ROOT, 'packages/core'),
          include: ['test/**/*.test.ts'],
          setupFiles: [setupFile],
        },
      },
      {
        test: {
          name: '@bentway/anthropic',
          root: resolve(ROOT, 'packages/anthropic'),
          include: ['test/**/*.test.ts'],
          setupFiles: [setupFile],
        },
      },
      {
        test: {
          name: '@bentway/openai',
          root: resolve(ROOT, 'packages/openai'),
          include: ['test/**/*.test.ts'],
          setupFiles: [setupFile],
        },
      },
      {
        test: {
          name: '@bentway/llama',
          root: resolve(ROOT, 'packages/llama'),
          include: ['test/**/*.test.ts'],
          setupFiles: [setupFile],
        },
      },
    ],
  },
});
