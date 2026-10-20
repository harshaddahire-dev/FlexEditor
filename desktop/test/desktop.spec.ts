import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { analyzeSync, generateSyncAsset } from '../../apps/server/test/helpers/media';

// run from the repository root (`pnpm desktop:test`)
const app = path.resolve(process.cwd(), 'desktop/app');
const electronBin = path.resolve(process.cwd(), 'desktop/node_modules/.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

test('the desktop app opens a folder, edits, and renders H.264 with its own encoder and the bundled FFmpeg', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-desktop-'));
  const footage = path.join(work, 'footage');
  await generateSyncAsset(path.join(footage, 'interview.mp4'), { seconds: 6 });

  const run = await electron.launch({
    executablePath: electronBin,
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] : []), app],
    env: { ...process.env, CUTROOM_DATA_DIR: path.join(work, 'data') },
  });
  try {
    const page = await run.firstWindow();
    await expect(page.getByRole('heading', { name: 'Cutroom' })).toBeVisible();
    // the native bridge is there, the web app is not in a browser tab
    expect(await page.evaluate(() => typeof (window as unknown as { cutroomDesktop?: { pickFolder: unknown } }).cutroomDesktop?.pickFolder)).toBe('function');

    await page.getByLabel('Project folder path').fill(footage);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    const bin = page.getByRole('listbox', { name: 'Media' });
    await expect(bin.getByRole('option')).toHaveCount(1);
    await bin.getByRole('option', { name: /interview\.mp4/ }).click();
    await page.keyboard.press(',');
    await expect(page.getByTestId('timeline-canvas')).toBeVisible();
    // Electron's Chromium decodes H.264, so the proxy is H.264 and the picture can be rendered by the browser engine from the original

    await page.getByRole('button', { name: 'Render', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'Render' });
    await dlg.getByLabel('File name').fill('desktop-render');
    await dlg.getByRole('button', { name: 'Start render' }).click();
    await expect(dlg.getByTestId('render-done')).toBeVisible({ timeout: 150_000 });
    await expect(dlg.getByText('Browser (WebCodecs)')).toBeVisible(); // not the FFmpeg fallback
    await expect(dlg.getByRole('button', { name: 'Show in folder' })).toBeVisible(); // desktop-only

    const file = path.join(footage, 'exports', 'desktop-render.mp4');
    const rep = await analyzeSync(file);
    expect(rep.flashTimes.length).toBeGreaterThanOrEqual(5);
    expect(rep.maxOffsetFrames).toBe(0);
  } finally {
    await run.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
