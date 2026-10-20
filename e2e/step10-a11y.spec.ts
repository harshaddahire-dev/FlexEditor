import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fakeModel } from './fakeModel';
import { openFootageAndInsert, resetProject } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

/** Serious and critical WCAG A/AA problems on the current screen (the part of the page under `include`, when given). */
async function violations(page: Page, include?: string) {
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (include) b = b.include(include);
  const r = await b.analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} [${(n.any[0]?.message ?? '').slice(0, 140)}]`).join(' | ')}`);
}

test('welcome screen has no serious accessibility violations', async ({ page, request }) => {
  await request.post('/api/project/close');
  await page.goto('/');
  await expect(page.getByLabel('Project folder path')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('editor, panels, dialogs: no serious violations in dark or light theme', async ({ page, request }) => {
  const model = await fakeModel([{ text: 'ok' }]);
  try {
    await openFootageAndInsert(page);
    const p = await (await request.post('/api/providers', { data: { kind: 'custom', name: 'Script', baseUrl: model.baseUrl } })).json();
    await request.put('/api/agent/settings', { data: { providerId: p.id, model: 'script-1', effort: 'medium', mode: 'auto' } });
    await page.reload();
    await page.getByRole('button', { name: 'Program', exact: true }).click().catch(() => undefined);

    const found: Record<string, string[]> = {};
    const scan = async (name: string, include?: string) => {
      const v = await violations(page, include);
      if (v.length) found[name] = v;
    };
    await scan('workspace (media)');
    for (const tab of ['Transcript', 'Captions', 'Effects', 'Transitions', 'Skills']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await scan(`library · ${tab}`);
    }
    await page.getByRole('tab', { name: 'Agent', exact: true }).click();
    await scan('agent panel');
    await page.getByLabel('Message the agent').fill('/p');
    await scan('agent panel with slash menu');
    await page.getByLabel('Message the agent').fill('');
    await page.getByRole('tab', { name: 'Inspector', exact: true }).click();

    for (const [button, tabName] of [[null, 'Project'], [null, 'Providers'], [null, 'Plugins & MCP'], [null, 'System']] as const) {
      void button;
      if (tabName === 'Project') await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('dialog').getByRole('tab', { name: tabName }).click();
      await scan(`settings · ${tabName}`, '[role="dialog"]');
    }
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Render', exact: true }).click();
    await scan('render dialog', '[role="dialog"]');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+k');
    await scan('command palette', '[role="dialog"], [cmdk-root]');
    await page.keyboard.press('Escape');

    // light theme
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await scan('workspace (light)');

    expect(found, JSON.stringify(found, null, 2)).toEqual({});
  } finally {
    await model.close();
    for (const pr of (await (await request.get('/api/providers')).json()).providers as { id: string }[]) await request.delete(`/api/providers/${pr.id}`);
  }
});

test('the whole editor can be driven from the keyboard, and the timeline lists its clips for screen readers', async ({ page }) => {
  await openFootageAndInsert(page);
  // the canvas is one tab stop with instructions; a real list of the clips is available next to it
  const canvas = page.getByTestId('timeline-canvas');
  await expect(canvas).toHaveAttribute('role', 'application');
  await expect(canvas).toHaveAccessibleDescription(/arrow keys/i);
  const list = page.getByRole('list', { name: 'Timeline clips' });
  await expect(list.getByRole('button', { name: /interview\.mp4.*V1.*0:00/ })).toBeAttached();
  await list.getByRole('button', { name: /interview\.mp4.*A1/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Selection' })).toContainText(/interview\.mp4/);

  // every toolbar control is reachable by Tab and has a name
  const names = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.topbar button, .tlbar button, .viewer button')].map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()),
  );
  expect(names.filter((n) => !n)).toEqual([]);
  // focus is visible
  await page.getByRole('button', { name: 'Settings' }).focus();
  const outline = await page.getByRole('button', { name: 'Settings' }).evaluate((e) => getComputedStyle(e).outlineStyle + getComputedStyle(e).boxShadow);
  expect(outline).not.toBe('nonenone');
});
