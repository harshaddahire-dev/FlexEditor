import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeModel } from './fakeModel';
import { resetProject } from './helpers';

const FAKE_MCP = path.resolve(import.meta.dirname, '../apps/server/test/fixtures/fake-mcp.mjs');

/** Captures the Skills panel, slash menu and Plugins & MCP settings for design checks (opt-in, @shots). */
test('capture extensions @shots', async ({ page, request }) => {
  await resetProject(request);
  const out = path.resolve(import.meta.dirname, '.tmp/shots');
  fs.mkdirSync(out, { recursive: true });
  const model = await fakeModel([{ text: 'ok' }]);
  try {
    await page.goto('/');
    await page.getByLabel('Project folder path').fill(process.env.E2E_FOOTAGE!);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Media' }).getByRole('option')).toHaveCount(3);
    const p = await (await request.post('/api/providers', { data: { kind: 'custom', name: 'Script', baseUrl: model.baseUrl } })).json();
    await request.put('/api/agent/settings', { data: { providerId: p.id, model: 'script-1', effort: 'medium', mode: 'full' } });
    await request.post('/api/extensions/mcp', { data: { name: 'Fake Tools', transport: 'stdio', command: process.execPath, args: [FAKE_MCP] } });
    await page.reload();
    await page.getByRole('tab', { name: 'Skills' }).click();
    await page.getByRole('button', { name: 'Show steps of podcast-cleanup' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, '12-skills.png') });
    await page.getByRole('tab', { name: 'Agent' }).click();
    await page.getByLabel('Message the agent').fill('/p');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, '13-slash.png') });
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Plugins & MCP' }).click();
    await expect(page.getByTestId('mcp-fake-tools').getByRole('status')).toContainText('Ready', { timeout: 15000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, '14-extensions.png') });
  } finally {
    await model.close();
    for (const pr of (await (await request.get('/api/providers')).json()).providers as { id: string }[]) await request.delete(`/api/providers/${pr.id}`);
    for (const s of (await (await request.get('/api/extensions')).json()).mcp as { id: string }[]) await request.delete(`/api/extensions/mcp/${s.id}`);
  }
});
