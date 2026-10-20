import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

// run from the repository root (`pnpm desktop:test`)
const app = path.resolve(process.cwd(), 'desktop/app');
const electronBin = path.resolve(process.cwd(), 'desktop/node_modules/.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const ffmpeg = path.resolve(app, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

test('a large clip plays from the original while its proxy is still being made', async ({}, testInfo) => {
  test.skip(process.platform === 'win32', 'uses a shell wrapper to slow the proxy down');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-early-'));
  const footage = path.join(work, 'footage');
  await fs.mkdir(footage, { recursive: true });
  const made = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(footage, 'big.mp4')]);
  expect(made.status).toBe(0);

  // an FFmpeg that is slow to start the proxy transcode (the picture encode), as on a long 4K clip
  const slow = path.join(work, 'slow-ffmpeg.sh');
  await fs.writeFile(slow, `#!/bin/sh\ncase "$*" in *libx264*) sleep 40;; esac\nexec "${ffmpeg}" "$@"\n`, { mode: 0o755 });

  const run = await electron.launch({
    executablePath: electronBin,
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] : []), `--user-data-dir=${path.join(work, 'profile')}`, app],
    env: { ...process.env, CUTROOM_DATA_DIR: path.join(work, 'data'), FFMPEG_PATH: slow },
  });
  try {
    const page = await run.firstWindow();
    await page.getByLabel('Project folder path').fill(footage);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    const bin = page.getByRole('listbox', { name: 'Media' });
    await bin.getByRole('option', { name: /big\.mp4/ }).click();
    await page.keyboard.press(',');
    await expect(page.getByTestId('timeline-canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Program' }).click();

    const jobs = async () => (await page.evaluate(() => fetch('/api/jobs').then((r) => r.json()))) as { kind: string; state: string }[];
    // the proxy is still running (or queued), yet the monitor has no "Preparing proxy…" note: it is showing the original
    await expect.poll(async () => (await jobs()).some((j) => j.kind === 'proxy' && (j.state === 'running' || j.state === 'queued')), { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(2500);
    expect((await jobs()).some((j) => j.kind === 'proxy' && j.state !== 'done')).toBe(true);
    await expect(page.getByText(/Preparing proxy/)).toHaveCount(0);
    // and it shows a real picture: an empty (black) monitor compresses to almost nothing
    const shot = await page.getByTestId('program-monitor').screenshot({ path: testInfo.outputPath('monitor.png') });
    expect(shot.length).toBeGreaterThan(15_000);
    expect((await jobs()).some((j) => j.kind === 'proxy' && j.state !== 'done')).toBe(true); // still not done: the original did it
  } finally {
    await run.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
