import { expect, test } from '@playwright/test';
import { proxyReady, resetProject, scan } from './helpers';

const footage = () => process.env.E2E_FOOTAGE!;
const FLAG = 'cutroom.layout.softwareDecode';

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

test('a monitor that stays black over a bright frame switches to software decoding, then says so', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((k) => localStorage.removeItem(k), FLAG);
  await page.getByLabel('Project folder path').fill(footage());
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const bin = page.getByRole('listbox', { name: 'Media' });
  await expect(bin.getByRole('option')).toHaveCount(3);
  await bin.getByRole('option', { name: /interview\.mp4/ }).click();
  await page.keyboard.press(',');
  await page.getByRole('button', { name: 'Program', exact: true }).click();
  await proxyReady(page);
  await expect(page.getByTestId('program-canvas')).toBeVisible();

  // a healthy monitor never trips the guard (the sync clip flashes white on frames 0, 30, 60…)
  await scan(page, 62);
  expect(await page.evaluate((k) => localStorage.getItem(k), FLAG)).not.toBe('1');
  await expect(page.getByRole('alert')).toHaveCount(0);

  // now make the output come out black although the decoded frame is bright
  await page.evaluate(() => {
    const v = (window as unknown as { __cutroom: { viewer: { compositor: { readPixel: () => number[] }; guard: { reset(): void } } } }).__cutroom.viewer;
    v.compositor.readPixel = () => [0, 0, 0, 255];
    v.guard.reset();
  });
  await scan(page, 62);
  expect(await page.evaluate((k) => localStorage.getItem(k), FLAG)).toBe('1'); // first it falls back to software decoding
  await page.evaluate(() => (window as unknown as { __cutroom: { viewer: { guard: { reset(): void } } } }).__cutroom.viewer.guard.reset());
  await scan(page, 62);
  await expect(page.getByRole('alert')).toContainText('cannot be shown on this graphics setup'); // and when that does not help, it says so
});
