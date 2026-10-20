import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

// run from the repository root (`pnpm desktop:test`)
const app = path.resolve(process.cwd(), 'desktop/app');
const electronBin = path.resolve(process.cwd(), 'desktop/node_modules/.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

/** A stand-in for the GitHub release: serves the `latest-*.yml` electron-updater reads. */
async function feed(version: string, notes: string) {
  const file = `Cutroom-${version}-test.AppImage`;
  const sha512 = crypto.createHash('sha512').update('x').digest('base64');
  const yml = `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: 1\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '2026-01-01T00:00:00.000Z'\nreleaseNotes: '${notes}'\n`;
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (/^\/latest[^?]*\.yml/.test(req.url ?? '')) res.writeHead(200, { 'content-type': 'text/yaml' }).end(yml);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { url, hits, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

async function launch(work: string, url: string) {
  const footage = path.join(work, 'footage');
  await fs.mkdir(footage, { recursive: true });
  const run = await electron.launch({
    executablePath: electronBin,
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] : []), app],
    env: { ...process.env, CUTROOM_DATA_DIR: path.join(work, 'data'), CUTROOM_UPDATE_URL: url, CUTROOM_UPDATE_NO_DOWNLOAD: '1' },
  });
  const page = await run.firstWindow();
  await page.getByLabel('Project folder path').fill(footage);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  return { run, page };
}

test('a newer release shows up in the top bar and in Settings, with its notes', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-update-'));
  const f = await feed('99.0.0', 'Faster exports');
  const { run, page } = await launch(work, f.url);
  try {
    expect(await page.evaluate(() => typeof (window as unknown as { cutroomDesktop: { updates: { check: unknown } } }).cutroomDesktop.updates.check)).toBe('function');
    await expect(page.getByTestId('update-pill')).toHaveCount(0); // nothing to say yet

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'System' }).click();
    await expect(page.getByTestId('update-current')).toContainText('Cutroom ');
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(page.getByTestId('update-line')).toHaveText('Version 99.0.0 is available');
    await expect(page.getByText('Faster exports')).toBeVisible();
    expect(f.hits.some((h) => h.startsWith('/latest'))).toBe(true);

    await page.keyboard.press('Escape');
    const pill = page.getByTestId('update-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('99.0.0');
  } finally {
    await run.close();
    await f.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('an older or equal release says you are up to date and shows no pill', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-update-'));
  const f = await feed('0.0.1', 'old');
  const { run, page } = await launch(work, f.url);
  try {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'System' }).click();
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(page.getByTestId('update-line')).toHaveText('You have the latest version');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('update-pill')).toHaveCount(0);
  } finally {
    await run.close();
    await f.close();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
