import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

// run from the repository root (`pnpm desktop:test`)
const app = path.resolve(process.cwd(), 'desktop/app');
const electronBin = path.resolve(process.cwd(), 'desktop/node_modules/.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const ffmpeg = path.resolve(app, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

test('Help → Copy diagnostics puts the graphics, codec, media and timeline facts on the clipboard', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-diag-'));
  const footage = path.join(work, 'footage');
  await fs.mkdir(footage, { recursive: true });
  const made = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(footage, 'clip.mp4')]);
  expect(made.status).toBe(0);
  const run = await electron.launch({
    executablePath: electronBin,
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] : []), `--user-data-dir=${path.join(work, 'profile')}`, app],
    env: { ...process.env, CUTROOM_DATA_DIR: path.join(work, 'data') },
  });
  try {
    const page = await run.firstWindow();
    await page.getByLabel('Project folder path').fill(footage);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('listbox', { name: 'Media' }).getByRole('option', { name: /clip\.mp4/ }).click();
    await page.keyboard.press(',');
    await expect(page.getByTestId('timeline-canvas')).toBeVisible();
    const text = await run.evaluate(async ({ Menu, dialog, clipboard }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never;
      const help = Menu.getApplicationMenu()!.items.find((i) => i.role === 'help')!;
      help.submenu!.items.find((i) => i.label === 'Copy diagnostics')!.click();
      for (let i = 0; i < 60 && !clipboard.readText().includes('--- log'); i++) await new Promise((r) => setTimeout(r, 250));
      return clipboard.readText();
    });
    expect(text).toMatch(/^Cutroom \d/);
    expect(text).toMatch(/"webgl2":"[^"]+"/);
    expect(text).toMatch(/"h264":(true|false)/);
    expect(text).toContain('Media clip.mp4: video');
    expect(text).toMatch(/video .*: 1 items; clip /);
    expect(text).toContain('--- log');
  } finally {
    await run.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
