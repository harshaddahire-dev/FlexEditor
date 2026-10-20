import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeModel } from './fakeModel';
import { resetProject } from './helpers';

/** Captures the agent chat mid-review for design checks (opt-in, @shots). */
test('capture chat @shots', async ({ page, request }) => {
  await resetProject(request);
  const out = path.resolve(import.meta.dirname, '.tmp/shots');
  fs.mkdirSync(out, { recursive: true });
  const model = await fakeModel([
    { text: 'Let me look at what we have. ', calls: [{ name: 'get_overview', args: {} }, { name: 'get_sequence', args: {} }] },
    { text: 'Placing the interview, then cutting out the second second.', calls: [{ name: 'add_clip', args: { mediaId: 'interview.mp4', at: 0, sourceIn: 0, sourceOut: 6 } }] },
    { calls: [{ name: 'remove_range', args: { from: 1, to: 2 } }, { name: 'set_clip', args: { clipId: 'nope', gainDb: -3 } }] },
    { text: 'I put the interview on the timeline and removed the **second second**. Everything stays in sync.\n\nOne thing to check: the clip id for the gain change did not exist, so I left levels alone.' },
  ]);
  try {
    await page.goto('/');
    await page.getByLabel('Project folder path').fill(process.env.E2E_FOOTAGE!);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Media' }).getByRole('option')).toHaveCount(3);
    const p = await (await request.post('/api/providers', { data: { kind: 'custom', name: 'Script', baseUrl: model.baseUrl } })).json();
    await request.put('/api/agent/settings', { data: { providerId: p.id, model: 'script-1', effort: 'medium', mode: 'auto' } });
    await page.reload();
    await page.getByRole('tab', { name: 'Agent' }).click();
    await page.getByLabel('Message the agent').fill('Put the interview on the timeline and cut out 1–2 s');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Everything stays in sync.')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, '11-agent-chat.png') });
  } finally {
    await model.close();
    for (const pr of (await (await request.get('/api/providers')).json()).providers as { id: string }[]) await request.delete(`/api/providers/${pr.id}`);
    await request.delete('/api/agent/chat');
  }
});
