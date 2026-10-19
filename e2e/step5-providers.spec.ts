import http from 'node:http';
import { expect, test } from '@playwright/test';
import { resetProject } from './helpers';

const KEY = 'sk-e2e-0123456789-SECRET';

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

test('connect a provider, pick a model, effort and mode — keys never reach the browser', async ({ page, request }) => {
  // a stand-in OpenAI-compatible server the app's own server can reach
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/models' && req.headers.authorization === `Bearer ${KEY}`) res.end(JSON.stringify({ data: [{ id: 'fake-large', context_length: 200000 }, { id: 'fake-small', context_length: 8000 }] }));
    else (res.statusCode = 401), res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    // every response the browser receives, so we can prove the key is never among them
    const bodies: string[] = [];
    page.on('response', async (r) => {
      if (r.url().includes('/api/')) bodies.push(await r.text().catch(() => ''));
    });

    await page.goto('/');
    await page.getByLabel('Project folder path').fill(process.env.E2E_FOOTAGE!);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Media' }).getByRole('option')).toHaveCount(3);

    // empty state invites a provider
    await page.getByRole('tab', { name: 'Agent' }).click();
    await expect(page.getByText('Connect a model provider to start.')).toBeVisible();
    await page.getByRole('button', { name: 'Add a provider' }).click();

    // settings → providers → add a custom endpoint
    await expect(page.getByRole('tab', { name: 'Providers' })).toHaveAttribute('data-state', 'active');
    await page.getByRole('button', { name: 'Add provider' }).click();
    await page.getByRole('radio', { name: 'Custom (OpenAI-compatible)' }).click();
    await page.getByLabel('Name').fill('Fake lab');
    await page.getByLabel('Base URL').fill(base);
    await page.getByLabel('API key').fill(KEY);
    await expect(page.getByLabel('API key')).toHaveAttribute('type', 'password');
    await page.locator('.pform').getByRole('button', { name: 'Add provider' }).click();

    const card = page.locator('.pcard', { hasText: 'Fake lab' });
    await expect(card).toContainText(`Key •••• ${KEY.slice(-4)}`);
    await card.getByRole('button', { name: 'Test' }).click();
    await expect(card.getByRole('status')).toHaveText(/2 models/);

    // a wrong key is reported without echoing it
    await card.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('API key').fill('wrong-key-0000000');
    await page.locator('.pform').getByRole('button', { name: 'Save' }).click();
    await card.getByRole('button', { name: 'Test' }).click();
    await expect(card.getByRole('alert')).toContainText('401');
    await expect(card.getByRole('alert')).not.toContainText('wrong-key');
    await card.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('API key').fill(KEY);
    await page.locator('.pform').getByRole('button', { name: 'Save' }).click();
    await page.keyboard.press('Escape');

    // the agent panel picked the new provider; choose a model, effort and mode
    await page.getByRole('button', { name: 'Model' }).click();
    await page.getByRole('option', { name: /fake-large/ }).click();
    await expect(page.getByRole('button', { name: 'Model' })).toContainText('fake-large');
    await expect(page.getByRole('meter', { name: 'Context used' })).toContainText('200k');
    await page.getByRole('radio', { name: 'High', exact: true }).click();
    await page.getByRole('radio', { name: 'Auto', exact: true }).click();
    await expect(page.getByText('Edits apply right away; review them as a diff and undo anything.')).toBeVisible();

    // a model id the list does not have can still be typed in
    await page.getByRole('button', { name: 'Model' }).click();
    await page.getByPlaceholder('Search or type a model id…').fill('my-own-model');
    await page.getByRole('option', { name: 'Use “my-own-model”' }).click();
    await expect(page.getByRole('button', { name: 'Model' })).toContainText('my-own-model');

    // persisted on the server: survives a reload
    await page.reload();
    await page.getByRole('tab', { name: 'Agent' }).click();
    await expect(page.getByRole('button', { name: 'Model' })).toContainText('my-own-model');
    await expect(page.getByRole('radio', { name: 'High', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Auto', exact: true })).toHaveAttribute('aria-checked', 'true');

    // the key was never in a single response the browser saw, and the API reports only a hint
    expect(bodies.join('\n')).not.toContain(KEY);
    const api = await (await request.get('/api/providers')).json();
    expect(JSON.stringify(api)).not.toContain(KEY);
    expect(api.providers[0]).toMatchObject({ name: 'Fake lab', hasKey: true, keyHint: KEY.slice(-4) });
    expect(api.agent).toMatchObject({ model: 'my-own-model', effort: 'high', mode: 'auto' });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const p of (await (await request.get('/api/providers')).json()).providers as { id: string }[]) await request.delete(`/api/providers/${p.id}`);
  }
});
