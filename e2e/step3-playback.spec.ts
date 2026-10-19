import { resetProject } from './helpers';
import { expect, test, type Page } from '@playwright/test';

const footage = () => process.env.E2E_FOOTAGE!;

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

type Clip = { id: string; start: number; duration: number; sourceIn: number; kind: string };
type Seq = { revision: number; sequence: { timebase: { rate: number }; tracks: { name: string; items: Record<string, Clip> }[] } };
const getSeq = async (page: Page): Promise<Seq> => (await page.request.get('/api/sequence')).json();
const clipsOn = (s: Seq, name: string) => Object.values(s.sequence.tracks.find((t) => t.name === name)!.items).sort((a, b) => a.start - b.start);

async function edit(page: Page, ops: unknown[], label: string) {
  const before = (await getSeq(page)).revision;
  const res = await page.request.post('/api/edit', { data: { ops, label, origin: 'user' } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await waitRevision(page, before + 1);
}
async function undo(page: Page) {
  const before = (await getSeq(page)).revision;
  await page.request.post('/api/history/undo');
  await waitRevision(page, before + 1);
}
async function waitRevision(page: Page, min: number) {
  await page.waitForFunction((m) => (window as unknown as { __cutroom: { useApp: { getState(): { revision: number } } } }).__cutroom.useApp.getState().revision >= m, min);
}

/** The interview's proxy exists, in the codec this browser reported, and the monitor is no longer waiting on it. */
async function proxyReady(page: Page) {
  await page.waitForFunction(() => {
    const s = (window as unknown as { __cutroom: { useApp: { getState(): { media: Record<string, { name: string; status: { proxy: string }; proxy?: { codec: string } }> } } } }).__cutroom.useApp.getState();
    return Object.values(s.media).some((m) => m.name === 'interview.mp4' && m.status.proxy === 'done' && m.proxy?.codec === 'vp9');
  }, undefined, { timeout: 60_000 });
  await expect(page.getByText('Preparing proxy…')).toBeHidden();
}

/** Paint every timeline frame 0…count-1 in turn and report, per frame, whether the monitor centre is white. */
async function scan(page: Page, count: number) {
  return page.evaluate(async (count) => {
    const w = window as unknown as {
      __cutroom: {
        useApp: { getState(): { sequence: { width: number; height: number; timebase: { rate: number; fps: { num: number; den: number } } } } };
        useTimeline: { getState(): { setPlayhead(t: number, s: unknown): void } };
        viewer: { idle(): Promise<void>; pixel(x: number, y: number): number[] | null; shown: { ticks: number; layers: unknown[] } | null };
      };
    };
    const { useApp, useTimeline, viewer } = w.__cutroom;
    const seq = useApp.getState().sequence;
    const frame = (seq.timebase.rate * seq.timebase.fps.den) / seq.timebase.fps.num;
    const out: { n: number; white: boolean; dark: boolean; ticks: number; layers: number }[] = [];
    for (let n = 0; n < count; n++) {
      useTimeline.getState().setPlayhead(n * frame, seq);
      await viewer.idle();
      const p = viewer.pixel(seq.width / 2, seq.height / 2)!;
      out.push({ n, white: p[0]! > 200 && p[1]! > 200 && p[2]! > 200, dark: p[0]! < 40 && p[1]! < 40 && p[2]! < 40, ticks: viewer.shown!.ticks, layers: viewer.shown!.layers.length });
    }
    return { frame, out };
  }, count);
}

function expectFlashes(r: Awaited<ReturnType<typeof scan>>, isFlash: (n: number) => boolean, length: number) {
  const bad: string[] = [];
  for (const f of r.out) {
    if (f.ticks !== f.n * r.frame) bad.push(`frame ${f.n}: painted tick ${f.ticks}`);
    const inside = f.n < length;
    const want = inside && isFlash(f.n);
    if (inside !== (f.layers === 1)) bad.push(`frame ${f.n}: ${f.layers} layers`);
    if (want ? !f.white : !f.dark) bad.push(`frame ${f.n}: expected ${want ? 'white' : 'black'}, got white=${f.white} dark=${f.dark}`);
  }
  expect(bad, bad.slice(0, 8).join('\n')).toEqual([]);
}

test('the program monitor shows the exact frame — flash on frame k·30 — before and after edits', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Project folder path').fill(footage());
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const bin = page.getByRole('listbox', { name: 'Media' });
  await expect(bin.getByRole('option')).toHaveCount(3);
  await bin.getByRole('option', { name: /interview\.mp4/ }).click();
  await page.keyboard.press(',');
  await page.getByRole('button', { name: 'Program', exact: true }).click();

  // the proxy is regenerated in a codec this browser decodes (VP9 here: the test Chromium has no H.264)
  await proxyReady(page);
  await expect(page.getByTestId('program-canvas')).toBeVisible();

  const R = (await getSeq(page)).sequence.timebase.rate;
  const F = R / 30;

  // A. untouched: white on frames 0, 30, 60 … 150, black everywhere else
  expectFlashes(await scan(page, 184), (n) => n % 30 === 0, 180);

  // B. ripple-delete 2.5 s…4.5 s: timeline frame n shows source frame n (n < 75) or n + 60
  let s = await getSeq(page);
  const v = clipsOn(s, 'V1')[0]!;
  await edit(page, [{ type: 'split', clipId: v.id, at: 75 * F }], 'split');
  s = await getSeq(page);
  await edit(page, [{ type: 'split', clipId: clipsOn(s, 'V1')[1]!.id, at: 135 * F }], 'split');
  s = await getSeq(page);
  await edit(page, [{ type: 'rippleDelete', clipIds: [clipsOn(s, 'V1')[1]!.id] }], 'ripple delete');
  expectFlashes(await scan(page, 124), (n) => (n < 75 ? n : n + 60) % 30 === 0, 120);
  await undo(page);
  await undo(page);
  await undo(page);

  // C. ripple-trim the head by half a second: frame n shows source frame n + 15
  s = await getSeq(page);
  await edit(page, [{ type: 'rippleTrim', clipId: clipsOn(s, 'V1')[0]!.id, edge: 'start', to: 15 * F }], 'ripple trim');
  expectFlashes(await scan(page, 170), (n) => (n + 15) % 30 === 0, 165);
  await undo(page);

  // D. plain trim keeps content on its timeline position: the first flash is gone, the rest stay put
  s = await getSeq(page);
  await edit(page, [{ type: 'trim', clipId: clipsOn(s, 'V1')[0]!.id, edge: 'start', to: 15 * F }], 'trim');
  const trimmed = (await scan(page, 184)).out;
  expect(trimmed.filter((f) => f.n < 15).every((f) => f.layers === 0 && f.dark)).toBe(true);
  expect(trimmed.filter((f) => f.n >= 15 && f.n < 180).every((f) => f.layers === 1 && f.white === (f.n % 30 === 0))).toBe(true);
  await undo(page);

  // E. 2× speed: frame n shows source frame 2n, so flashes land every 15 frames and the clip is 90 frames long
  s = await getSeq(page);
  await edit(page, [{ type: 'setSpeed', clipId: clipsOn(s, 'V1')[0]!.id, speed: { num: 2, den: 1 } }], 'speed 2x');
  expectFlashes(await scan(page, 94), (n) => (2 * n) % 30 === 0, 90);
});

test('moving the playhead with the keyboard repaints the monitor', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Project folder path').fill(footage());
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const bin = page.getByRole('listbox', { name: 'Media' });
  await expect(bin.getByRole('option')).toHaveCount(3);
  await bin.getByRole('option', { name: /interview\.mp4/ }).click();
  await page.keyboard.press(',');
  await page.getByRole('button', { name: 'Program', exact: true }).click();
  await proxyReady(page);
  const centre = () => page.evaluate(async () => {
    const v = (window as unknown as { __cutroom: { viewer: { idle(): Promise<void>; pixel(x: number, y: number): number[] } } }).__cutroom.viewer;
    await v.idle();
    return v.pixel(320, 180)![0]! > 200;
  });

  await page.getByTestId('program-monitor').click({ position: { x: 5, y: 5 } }); // focus away from inputs
  await page.keyboard.press('Home');
  expect(await centre()).toBe(true); // frame 0 is the first flash
  await page.keyboard.press('ArrowRight');
  expect(await centre()).toBe(false);
  await page.keyboard.press('ArrowLeft');
  expect(await centre()).toBe(true);
});
