import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeModel, type Step } from './fakeModel';
import { getSeq, resetProject } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

const SCRIPT: Step[] = [
  { text: 'Let me look at what we have. ', calls: [{ name: 'get_overview', args: {} }] },
  { text: 'Placing the interview, then cutting out the second second.', calls: [{ name: 'add_clip', args: { mediaId: 'interview.mp4', at: 0, sourceIn: 0, sourceOut: 6 } }] },
  { calls: [{ name: 'remove_range', args: { from: 1, to: 2 } }] },
  { text: 'I put the interview on the timeline and removed the second second. Everything stays in sync.' },
];

async function setup(page: Page, request: APIRequestContext, mode: 'ask' | 'auto', steps: Step[] = SCRIPT) {
  const model = await fakeModel(steps);
  await page.goto('/');
  await page.getByLabel('Project folder path').fill(process.env.E2E_FOOTAGE!);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Media' }).getByRole('option')).toHaveCount(3);
  const p = await (await request.post('/api/providers', { data: { kind: 'custom', name: 'Script', baseUrl: model.baseUrl } })).json();
  await request.put('/api/agent/settings', { data: { providerId: p.id, model: 'script-1', effort: 'off', mode } });
  await page.reload();
  await page.getByRole('tab', { name: 'Agent' }).click();
  return { model, providerId: p.id as string };
}

async function cleanupProviders(request: APIRequestContext) {
  for (const p of (await (await request.get('/api/providers')).json()).providers as { id: string }[]) await request.delete(`/api/providers/${p.id}`);
  await request.delete('/api/agent/chat');
}

test('ask the agent to edit: steps stream in, the timeline changes, and "Undo all" reverts the run', async ({ page, request }) => {
  const { model } = await setup(page, request, 'auto');
  try {
    await expect(page.getByText('What should we cut?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove the silences and filler words' })).toBeVisible();
    await page.getByLabel('Message the agent').fill('Put the interview on the timeline and cut out 1–2 s');
    await page.getByRole('button', { name: 'Send' }).click();

    const log = page.getByRole('log', { name: 'Conversation' });
    await expect(log.getByText('Put the interview on the timeline and cut out 1–2 s')).toBeVisible();
    await expect(log.getByText('I put the interview on the timeline and removed the second second.')).toBeVisible();
    await expect(log.getByText('Looked at the project')).toBeVisible();
    await expect(log.getByText('Add m_int')).toHaveCount(0); // titles show what was done, not raw ids
    await expect(log.getByText(/Add interview\.mp4 at 0/)).toBeVisible();
    await expect(log.getByText(/Remove 1 → 2 and close the gap/)).toBeVisible();

    // the context meter moved (usage reported by the model)
    await expect(page.getByRole('meter', { name: 'Context used' })).toContainText('2.2k / 128k');

    // the timeline now holds the agent's work: 5 s long, clips carry the AI badge
    const s = await getSeq(page);
    const rate = s.sequence.timebase.rate;
    const v1 = Object.values(s.sequence.tracks.find((t) => t.name === 'V1')!.items);
    expect(v1.length).toBe(2);
    expect(Math.max(...v1.map((c) => c.start + c.duration)) / rate).toBe(5);

    // review card: what changed, with Keep / Undo all
    const review = log.locator('.review');
    await expect(review).toContainText('+');
    await expect(review.getByRole('button', { name: 'Keep' })).toBeVisible();
    await review.getByRole('button', { name: 'Undo all' }).click();
    await expect(review).toContainText('Undone');
    const after = await getSeq(page);
    expect(Object.values(after.sequence.tracks.find((t) => t.name === 'V1')!.items)).toHaveLength(0);
    expect(model.requests.length).toBe(4);
  } finally {
    await model.close();
    await cleanupProviders(request);
  }
});

test('keeping the edits clears the AI markers; the conversation survives a reload', async ({ page, request }) => {
  const { model } = await setup(page, request, 'auto');
  try {
    await page.getByLabel('Message the agent').fill('do the cut');
    await page.getByRole('button', { name: 'Send' }).click();
    const review = page.getByRole('log', { name: 'Conversation' }).locator('.review');
    await review.getByRole('button', { name: 'Keep' }).click();
    await expect(review).toContainText('Accepted');
    const clips = Object.values((await getSeq(page)).sequence.tracks.flatMap((t) => Object.values(t.items))) as { createdBy?: string; accepted?: boolean }[];
    expect(clips.length).toBeGreaterThan(0);
    expect(clips.every((c) => c.accepted)).toBe(true);

    await page.reload();
    await page.getByRole('tab', { name: 'Agent' }).click();
    const log = page.getByRole('log', { name: 'Conversation' });
    await expect(log.getByText('do the cut')).toBeVisible();
    await expect(log.getByText('I put the interview on the timeline')).toBeVisible();
    await expect(log.locator('.review')).toContainText('Accepted');
  } finally {
    await model.close();
    await cleanupProviders(request);
  }
});

test('Ask mode shows an approval card per edit; Deny keeps that edit off the timeline', async ({ page, request }) => {
  const { model } = await setup(page, request, 'ask');
  try {
    await page.getByLabel('Message the agent').fill('do the cut');
    await page.getByRole('button', { name: 'Send' }).click();
    const log = page.getByRole('log', { name: 'Conversation' });
    const ask = log.getByRole('group', { name: 'Approve this edit' });
    await expect(ask).toBeVisible();
    expect((await getSeq(page)).sequence.tracks.flatMap((t) => Object.values(t.items))).toHaveLength(0); // nothing applied yet
    await ask.getByRole('button', { name: 'Approve', exact: true }).click(); // add_clip
    await expect(ask).toBeVisible(); // the next edit (remove_range) asks again
    await expect(log.getByText(/Add interview\.mp4 at 0/)).toBeVisible();
    await ask.getByRole('button', { name: 'Deny' }).click();
    await expect(log.getByText('I put the interview on the timeline and removed the second second.')).toBeVisible();
    const s = await getSeq(page);
    const rate = s.sequence.timebase.rate;
    expect(Math.max(...s.sequence.tracks.flatMap((t) => Object.values(t.items)).map((c) => c.start + c.duration)) / rate).toBe(6); // removal declined
    await expect(log.getByText('Declined')).toHaveCount(1); // the card says so; the model is told too
  } finally {
    await model.close();
    await cleanupProviders(request);
  }
});

test('Stop ends a run that is waiting for approval', async ({ page, request }) => {
  const { model } = await setup(page, request, 'ask');
  try {
    await page.getByLabel('Message the agent').fill('do the cut');
    await page.getByRole('button', { name: 'Send' }).click();
    const log = page.getByRole('log', { name: 'Conversation' });
    await expect(log.getByRole('group', { name: 'Approve this edit' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(log.getByText('Stopped.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  } finally {
    await model.close();
    await cleanupProviders(request);
  }
});
