import { defineConfig } from '@playwright/test';

// Drives the real desktop app (Electron) built by `node desktop/build.mjs smoke` — run with `pnpm desktop:test`.
export default defineConfig({
  testDir: './test',
  testMatch: '*.spec.ts',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  expect: { timeout: 20_000 },
});
