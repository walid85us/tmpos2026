import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// M2 frontend render/behavior harness. Scoped to `*.test.tsx` so it does NOT
// collide with the existing node:test/tsx suites (server/**, src/**/*.test.ts,
// tests/firestore/*.mjs), which the deterministic runner executes separately.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.tsx'],
    watch: false,
    css: false,
    reporters: ['default'],
  },
});
