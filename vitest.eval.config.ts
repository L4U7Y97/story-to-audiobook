/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/** `npm run eval:llm`: runs the fixtures through the real API. Not part of `npm test` (costs money). */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/eval/**/*.eval.ts'],
    testTimeout: 10 * 60 * 1000,
  },
});
