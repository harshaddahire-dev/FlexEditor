import { resetProject } from './helpers';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const footage = () => process.env.E2E_FOOTAGE!;

// The server keeps its project open across page loads (that is the feature), so start each test from a closed project.
test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

/** Fail the test on any console error or unhandled page error. */
function watchErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // Chromium's "Failed to load resource" console line omits the URL; record it from the response instead.
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/api/health') ) errors.push(`http ${r.status()}: ${r.url()}`);
  });
  return () => errors.filter((e) => !e.startsWith('console: Failed to load resource'));
}

test('setup screen guides the user when FFmpeg is missing', async ({ page }) => {
  const errors = watchErrors(page);
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: {
        app: 'cutroom', version: '0.1.0', dataDir: '/x', hasProject: false,
        ffmpeg: { ok: false, ffmpeg: null, ffprobe: null, encoders: {}, filters: {}, warnings: [], platform: 'darwin', problems: ['ffmpeg was not found (looked for "ffmpeg").'], installHints: ['brew install ffmpeg'] },
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'FFmpeg is required' })).toBeVisible();
  await expect(page.getByText('ffmpeg was not found')).toBeVisible();
  await expect(page.getByText('brew install ffmpeg')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  // the filtered console noise from the intentionally failing recheck is not an app error
  expect(errors().filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
});

test('open folder → import → proxies → inspect → upload → persist → remove', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');

  // --- welcome → open by path
  await expect(page.getByRole('heading', { name: 'Cutroom' })).toBeVisible();
  await page.getByLabel('Project folder path').fill(footage());
  await page.getByRole('button', { name: 'Open', exact: true }).click();

  // --- workspace with the three media items (notes.txt ignored)
  const bin = page.getByRole('listbox', { name: 'Media' });
  await expect(bin.getByRole('option')).toHaveCount(3);
  await expect(bin.getByRole('option', { name: /interview\.mp4/ })).toBeVisible();
  await expect(bin.getByRole('option', { name: /music\.wav/ })).toBeVisible();
  await expect(page.locator('.topbar__name')).toHaveText(/cutroom-e2e-footage/);

  // --- editor is usable and layout is the specified one
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  expect((await box('.topbar')).height).toBe(40);
  expect((await box('.panel--left')).width).toBeCloseTo(280, 0);
  expect((await box('.panel--right')).width).toBeCloseTo(380, 0);
  expect((await box('.panel--timeline')).height).toBeGreaterThanOrEqual(900 * 0.38 - 1);

  // --- background proxies finish; progress is visible then settles
  const interview = bin.getByRole('option', { name: /interview\.mp4/ });
  await expect(interview.getByRole('img', { name: /Edit proxy: ready/ })).toBeVisible({ timeout: 60_000 });
  await expect(bin.getByRole('option', { name: /phone-vertical\.mp4/ }).getByRole('img', { name: /Edit proxy: ready/ })).toBeVisible({ timeout: 60_000 });
  await expect(interview.locator('img')).toHaveJSProperty('complete', true);

  // --- inspect: source facts come from ffprobe, not guesses
  await interview.click();
  const details = page.getByRole('list', { name: 'Media details' }).or(page.getByLabel('Media details'));
  await expect(details).toContainText('640×360');
  await expect(details).toContainText('30 fps');
  await expect(details).toContainText('00:00:06:00');
  await bin.getByRole('option', { name: /phone-vertical\.mp4/ }).click();
  await expect(details).toContainText('360×640 (coded 640×360)');
  await expect(details).toContainText('Rotation');
  await expect(page.getByAltText(/Poster frame of phone-vertical/)).toBeVisible();

  // --- list view + filter
  await page.getByRole('radio', { name: 'List view' }).click();
  await page.getByLabel('Filter media').fill('music');
  await expect(bin.getByRole('option')).toHaveCount(1);
  await page.getByLabel('Clear filter').click();
  await expect(bin.getByRole('option')).toHaveCount(3);
  await page.getByRole('radio', { name: 'Grid view' }).click();

  // --- upload through the real file input
  await page.getByRole('button', { name: 'Import' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Files…' }).click();
  await (await chooser).setFiles(process.env.E2E_UPLOAD!);
  await expect(bin.getByRole('option', { name: /still\.png/ })).toBeVisible();
  await expect(bin.getByRole('option')).toHaveCount(4);

  // --- layout persists + project restores after a reload (server keeps the project open)
  await page.reload();
  await expect(bin.getByRole('option')).toHaveCount(4);
  await expect(page.locator('.panel--left')).toBeVisible();

  // --- remove from project (file stays on disk, stays removed)
  const still = bin.getByRole('option', { name: /still\.png/ });
  await still.hover();
  await still.getByRole('button', { name: /Actions for still\.png/ }).click();
  await page.getByRole('menuitem', { name: 'Remove from project' }).click();
  await expect(bin.getByRole('option')).toHaveCount(3);

  // --- close → welcome shows it under Recent, reopening restores without regenerating
  await page.locator('.topbar__project').click();
  await page.getByRole('menuitem', { name: 'Close project' }).click();
  await expect(page.getByRole('heading', { name: 'Cutroom' })).toBeVisible();
  await page.locator('.recent__item').first().click();
  await expect(bin.getByRole('option')).toHaveCount(3);
  await expect(interview.getByRole('img', { name: /Edit proxy: ready/ })).toBeVisible();

  expect(errors()).toEqual([]);
});

test('panels resize with the keyboard and persist; agent panel collapses', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  // the server may still have the previous test's project open: wait for whichever screen appears
  await expect(page.locator('.panel--left').or(page.getByLabel('Project folder path'))).toBeVisible();
  if (await page.getByLabel('Project folder path').isVisible()) {
    await page.getByLabel('Project folder path').fill(footage());
    await page.getByRole('button', { name: 'Open', exact: true }).click();
  }
  await expect(page.locator('.panel--left')).toBeVisible();

  const left = page.getByRole('separator', { name: 'Resize library panel' });
  const before = (await page.locator('.panel--left').boundingBox())!.width;
  await left.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await page.locator('.panel--left').boundingBox())!.width).toBe(before + 32);
  await page.reload();
  await expect.poll(async () => (await page.locator('.panel--left').boundingBox())!.width).toBe(before + 32);

  await page.getByRole('button', { name: 'Toggle agent panel' }).click();
  await expect(page.locator('.panel--right')).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle agent panel' }).click();
  await expect(page.locator('.panel--right')).toBeVisible();

  // theme switch is tokenised end-to-end
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'System' }).click();
  await expect(page.getByText('Data folder')).toBeVisible();
  await page.getByLabel('Theme').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByLabel('Theme').selectOption('dark');

  expect(errors()).toEqual([]);
});
