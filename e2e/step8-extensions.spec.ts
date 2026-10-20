import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeModel, type Step } from './fakeModel';
import { resetProject } from './helpers';

const FAKE_MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/server/test/fixtures/fake-mcp.mjs');

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

async function openProject(page: Page) {
  await page.goto('/');
  await page.getByLabel('Project folder path').fill(process.env.E2E_FOOTAGE!);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Media' }).getByRole('option')).toHaveCount(3);
}

async function connectModel(request: APIRequestContext, baseUrl: string, mode: 'auto' | 'full'): Promise<string> {
  const p = await (await request.post('/api/providers', { data: { kind: 'custom', name: 'Script', baseUrl } })).json();
  await request.put('/api/agent/settings', { data: { providerId: p.id, model: 'script-1', effort: 'off', mode } });
  return p.id as string;
}

async function cleanup(request: APIRequestContext) {
  for (const p of (await (await request.get('/api/providers', { timeout: 5000 })).json()).providers as { id: string }[]) await request.delete(`/api/providers/${p.id}`);
  for (const s of (await (await request.get('/api/extensions')).json()).mcp as { id: string }[]) await request.delete(`/api/extensions/mcp/${s.id}`);
  await request.put('/api/extensions/skills/shorts-reel', { data: { enabled: true } });
  await request.delete('/api/agent/chat');
}

test('Skills tab: eight built-ins, steps preview, switch off; /commands in the agent chat', async ({ page, request }) => {
  const model = await fakeModel([{ text: 'Following the skill.' }]);
  try {
    await openProject(page);
    await connectModel(request, model.baseUrl, 'auto');
    await page.reload();
    await page.getByRole('tab', { name: 'Skills' }).click();
    const list = page.getByRole('list', { name: 'Skills' });
    await expect(list.getByRole('listitem')).toHaveCount(9); // 8 built-ins + the example plugin's skill
    await expect(list.getByText('/youtube-retention-cut')).toBeVisible();
    await expect(list.getByText('Tighten talking-head footage for YouTube')).toBeVisible();

    // preview the steps
    await list.getByRole('button', { name: 'Show steps of shorts-reel' }).click();
    await expect(page.getByTestId('skill-shorts-reel').locator('pre')).toContainText('ONE idea that stands alone');

    // switching off removes it from the agent's menu
    await page.getByRole('switch', { name: 'Enable shorts-reel' }).click();
    await expect(page.getByTestId('skill-shorts-reel')).toHaveAttribute('data-off', 'true');
    await page.getByRole('tab', { name: 'Agent' }).click();
    const box = page.getByLabel('Message the agent');
    await box.fill('/sh');
    await expect(page.getByRole('listbox', { name: 'Skills' })).toHaveCount(0);
    await box.fill('/ch');
    await expect(page.getByRole('option', { name: /chapter-markers/ })).toBeVisible();
    await page.keyboard.press('Tab'); // completes the highlighted skill
    await expect(box).toHaveValue('/chapter-markers ');
    await box.type('for this interview');
    await page.getByRole('button', { name: 'Send' }).click();

    const log = page.getByRole('log', { name: 'Conversation' });
    await expect(log.getByText('/chapter-markers for this interview')).toBeVisible(); // what the user typed
    await expect(log.getByText('Following the skill.')).toBeVisible();
    const first = model.requests[0] as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };
    expect(first.messages.at(-1)!.content).toContain('Use the "chapter-markers" skill');
    expect(first.messages[0]!.content).toContain('- chapter-markers: ');
    expect(first.messages[0]!.content).not.toContain('- shorts-reel: '); // disabled skills are not offered
  } finally {
    await model.close();
    await cleanup(request);
  }
});

test('Run on a skill sends it to the agent', async ({ page, request }) => {
  const model = await fakeModel([{ text: 'On it.' }]);
  try {
    await openProject(page);
    await connectModel(request, model.baseUrl, 'auto');
    await page.reload();
    await page.getByRole('tab', { name: 'Skills' }).click();
    await page.getByTestId('skill-podcast-cleanup').getByRole('button', { name: 'Run' }).click();
    const log = page.getByRole('log', { name: 'Conversation' });
    await expect(log.getByText('/podcast-cleanup')).toBeVisible();
    await expect(log.getByText('On it.')).toBeVisible();
  } finally {
    await model.close();
    await cleanup(request);
  }
});

test('Plugins & MCP: add an MCP server in Settings, then use its tool in Full access only', async ({ page, request }) => {
  const model = await fakeModel([
    { text: 'Checking the tool. ', calls: [{ name: 'mcp_fake-tools__echo', args: { text: 'hello from the agent' } }] },
    { text: 'The tool answered.' },
  ]);
  try {
    await openProject(page);
    const providerId = await connectModel(request, model.baseUrl, 'full');
    await page.reload();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Plugins & MCP' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText('run code outside Cutroom')).toBeVisible();
    const plugin = dlg.getByTestId('plugin-pacing-tools');
    await expect(plugin).toContainText('Pacing tools');
    await expect(plugin.getByRole('status')).toContainText('Ready');

    await dlg.getByRole('button', { name: 'Add MCP server' }).click();
    await dlg.getByLabel('Name', { exact: true }).fill('Fake Tools');
    await dlg.getByLabel('Command', { exact: true }).fill(process.execPath);
    await dlg.getByLabel('Arguments').fill(`"${FAKE_MCP}"`);
    await dlg.getByLabel(/Environment/).fill('TOKEN=never-shown');
    await dlg.getByRole('button', { name: 'Add server' }).click();
    const card = dlg.getByTestId('mcp-fake-tools');
    await expect(card.getByRole('status')).toContainText('Ready', { timeout: 15_000 });
    await expect(card.locator('.chip')).toHaveCount(4);
    await expect(card.getByText('echo', { exact: true })).toBeVisible();
    await expect(dlg).not.toContainText('never-shown');

    // a server that cannot start shows why, instead of failing silently
    await dlg.getByRole('button', { name: 'Add MCP server' }).click();
    await dlg.getByLabel('Name', { exact: true }).fill('Broken');
    await dlg.getByLabel('Command', { exact: true }).fill('/nonexistent/binary-xyz');
    await dlg.getByRole('button', { name: 'Add server' }).click();
    await expect(dlg.getByTestId('mcp-broken').getByRole('alert')).toContainText('Could not start', { timeout: 15_000 });
    await dlg.getByRole('button', { name: 'Remove Broken' }).click();
    await expect(dlg.getByTestId('mcp-broken')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Full access: the model sees and calls the MCP tool
    await page.getByRole('tab', { name: 'Agent' }).click();
    await page.getByLabel('Message the agent').fill('Use the fake tool');
    await page.getByRole('button', { name: 'Send' }).click();
    const log = page.getByRole('log', { name: 'Conversation' });
    await expect(log.getByText('The tool answered.')).toBeVisible();
    await expect(log.getByText('fake tools · echo')).toBeVisible();
    const first = model.requests[0] as { tools: { function: { name: string } }[] };
    expect(first.tools.map((t) => t.function.name)).toContain('mcp_fake-tools__echo');
    const second = model.requests[1] as { messages: { role: string; content: string }[] };
    expect(second.messages.find((m) => m.role === 'tool')!.content).toContain('echo:hello from the agent');

    // Auto mode: the same tool is not offered
    await request.put('/api/agent/settings', { data: { providerId, model: 'script-1', effort: 'off', mode: 'auto' } });
    await page.reload();
    await page.getByRole('tab', { name: 'Agent' }).click();
    await page.getByLabel('Message the agent').fill('Again');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => model.requests.length).toBeGreaterThanOrEqual(3);
    const auto = model.requests.at(-1) as { tools: { function: { name: string } }[] };
    expect(auto.tools.map((t) => t.function.name)).not.toContain('mcp_fake-tools__echo');
  } finally {
    await model.close();
    await cleanup(request);
  }
});
