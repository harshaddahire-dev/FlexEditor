import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { resetProject } from './helpers';

/** Not an assertion suite — captures the main states to e2e/.tmp/shots for design review. */
const out = path.resolve(import.meta.dirname, '.tmp/shots');

test('capture screenshots @shots', async ({ page, request }) => {
  await resetProject(request);
  fs.mkdirSync(out, { recursive: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cutroom' })).toBeVisible();
  await page.screenshot({ path: path.join(out, '1-welcome.png') });

  await page.getByLabel('Project folder path').fill(process.env.E2E_FOOTAGE!);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const bin = page.getByRole('listbox', { name: 'Media' });
  await expect(bin.getByRole('option')).toHaveCount(3);
  await page.screenshot({ path: path.join(out, '2-workspace-processing.png') });

  await expect(bin.getByRole('option', { name: /phone-vertical/ }).getByRole('img', { name: /Edit proxy: ready/ })).toBeVisible({ timeout: 60_000 });
  await bin.getByRole('option', { name: /phone-vertical/ }).click();
  await page.screenshot({ path: path.join(out, '3-workspace-selected.png') });

  // a populated timeline
  await bin.getByRole('option', { name: /interview/ }).click();
  await page.keyboard.press(',');
  await bin.getByRole('option', { name: /phone-vertical/ }).click();
  await page.keyboard.press(',');
  await bin.getByRole('option', { name: /music/ }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('.');
  await page.keyboard.press('m');
  await page.keyboard.press('Shift+c');
  await page.keyboard.press('Shift+z');
  await page.waitForTimeout(400);
  await page.getByRole('option', { name: /interview/ }).first().click();
  await page.screenshot({ path: path.join(out, '7-timeline.png') });
  await page.getByRole('radio', { name: 'List view' }).click();
  await page.screenshot({ path: path.join(out, '4-list-view.png') });

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.screenshot({ path: path.join(out, '5-settings.png') });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'System' }).click();
  await page.getByLabel('Theme').selectOption('light');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(out, '6-light-theme.png') });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'System' }).click();
  await page.getByLabel('Theme').selectOption('dark');
});
