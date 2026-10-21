import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

// run from the repository root (`pnpm desktop:test`)
const app = path.resolve(process.cwd(), 'desktop/app');
const electronBin = path.resolve(process.cwd(), 'desktop/node_modules/.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const ffmpeg = path.resolve(app, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

test('a missing transcription model is detected and installed with one click', async () => {
  test.skip(process.platform === 'win32', 'uses a shell script as the stand-in whisper.cpp');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-whisper-'));
  const footage = path.join(work, 'footage');
  await fs.mkdir(footage, { recursive: true });
  const made = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(footage, 'talk.mp4')]);
  expect(made.status).toBe(0);
  // the program is "installed" (a stand-in); only the model is missing, and it comes from a local server
  const bin = path.join(work, 'whisper-cli');
  await fs.writeFile(bin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/ggml-base.bin') res.writeHead(200, { 'content-length': 4000 }).end(Buffer.alloc(4000, 1));
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const modelBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const run = await electron.launch({
    executablePath: electronBin,
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] : []), `--user-data-dir=${path.join(work, 'profile')}`, app],
    env: { ...process.env, CUTROOM_DATA_DIR: path.join(work, 'data'), WHISPER_CPP_BIN: bin, CUTROOM_WHISPER_MODEL_BASE: modelBase },
  });
  try {
    const page = await run.firstWindow();
    await page.getByLabel('Project folder path').fill(footage);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('listbox', { name: 'Media' }).getByRole('option', { name: /talk\.mp4/ }).click();
    await page.getByRole('tab', { name: 'Transcript' }).click();

    const card = page.getByTestId('whisper-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('the base model');
    await card.getByRole('button', { name: 'Install transcription' }).click();
    // the card goes away once the model is in place, and the model is where the app looks for it
    await expect(card).toHaveCount(0, { timeout: 30_000 });
    expect((await fs.stat(path.join(work, 'data', 'models', 'ggml-base.bin'))).size).toBe(4000);
    expect(hits).toEqual(['/ggml-base.bin']);
  } finally {
    await run.close();
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
