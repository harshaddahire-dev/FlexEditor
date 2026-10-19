import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// An isolated app-data dir so e2e never touches the developer's real recent-projects list.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-e2e-data-'));

// Use the pre-installed Chromium when present (CI images / sandboxes); otherwise Playwright's own.
const here = path.dirname(fileURLToPath(import.meta.url));
const preinstalled = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    launchOptions: fs.existsSync(preinstalled) ? { executablePath: preinstalled, args: ['--no-sandbox'] } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    cwd: '..',
    url: 'http://localhost:5173',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      CUTROOM_DATA_DIR: dataDir,
      // a stand-in with whisper.cpp's CLI contract, so the transcript path is exercised end to end
      WHISPER_CPP_BIN: path.join(here, 'fixtures', 'fake-whisper.mjs'),
      WHISPER_MODEL: path.join(here, 'fixtures', 'ggml-fake.bin'),
    },
  },
});
