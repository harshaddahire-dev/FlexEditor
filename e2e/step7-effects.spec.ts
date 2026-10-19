import { expect, test, type Page } from '@playwright/test';
import { getSeq, resetFolder, resetProject } from './helpers';

type Hook = {
  __cutroom: {
    useApp: { getState(): { sequence: { timebase: { rate: number }; width: number; height: number; tracks: { id: string; name: string; kind: string; items: Record<string, { id: string; start: number; duration: number; styleId?: string }>; transitions: { type: string; duration: number }[] }[] }; media: Record<string, { id: string; name: string; status: Record<string, string> }> } };
    useTimeline: { getState(): { setPlayhead(t: number, s: unknown): void; select(ids: string[]): void } };
    viewer: { idle(): Promise<void>; request(): void; pixel(x: number, y: number): number[] };
  };
};

async function open(page: Page, dir: string, names: string[]) {
  await page.goto('/');
  await page.getByLabel('Project folder path').fill(dir);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Media' }).getByRole('option').first()).toBeVisible();
  await page.waitForFunction((n) => {
    const m = Object.values((window as unknown as Hook).__cutroom.useApp.getState().media);
    return n.every((name) => m.some((x) => x.name === name && x.status.proxy === 'done'));
  }, names, { timeout: 60_000 });
}

/** Colour of the program monitor's centre at a timeline time, from the real compositor output. */
async function colorAt(page: Page, seconds: number): Promise<number[]> {
  return page.evaluate(async (s) => {
    const h = (window as unknown as Hook).__cutroom;
    const seq = h.useApp.getState().sequence;
    h.useTimeline.getState().setPlayhead(s * seq.timebase.rate, seq);
    h.viewer.request();
    await h.viewer.idle();
    return h.viewer.pixel(seq.width / 2, seq.height / 2);
  }, seconds);
}

const select = (page: Page, id: string) => page.evaluate((i) => (window as unknown as Hook).__cutroom.useTimeline.getState().select([i]), id);

async function placeRedAndBlue(page: Page) {
  const state = await page.evaluate(() => {
    const s = (window as unknown as Hook).__cutroom.useApp.getState();
    return { media: Object.values(s.media).map((m) => ({ id: m.id, name: m.name })), v1: s.sequence.tracks.find((t) => t.name === 'V1')!.id, rate: s.sequence.timebase.rate };
  });
  const id = (n: string) => state.media.find((m) => m.name === n)!.id;
  // red 0.5–2.5 s at 0, blue 0.5–2.5 s right after: both have half a second of spare footage on each side of the cut
  const R = state.rate;
  const res = await page.request.post('/api/edit', {
    data: {
      origin: 'user',
      label: 'Place clips',
      ops: [
        { type: 'overwrite', at: 0, clips: [{ trackId: state.v1, mediaId: id('red.mp4'), sourceIn: 0.5 * R, sourceOut: 2.5 * R }] },
        { type: 'overwrite', at: 2 * R, clips: [{ trackId: state.v1, mediaId: id('blue.mp4'), sourceIn: 0.5 * R, sourceOut: 2.5 * R }] },
      ],
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const seq = (await getSeq(page)).sequence.tracks.find((t) => t.name === 'V1')!;
  const clips = Object.values(seq.items).sort((a, b) => a.start - b.start);
  return { red: clips[0]!.id, blue: clips[1]!.id, R };
}

const isRed = (p: number[]) => p[0]! > 200 && p[1]! < 50 && p[2]! < 50;
const isBlue = (p: number[]) => p[2]! > 200 && p[0]! < 50 && p[1]! < 50;

test.describe('colour fixtures', () => {
  test.beforeEach(async ({ request }) => {
    await resetFolder(request, process.env.E2E_COLORS!);
  });

  test('a cross dissolve blends the two clips; effects and keyframes change real pixels', async ({ page }) => {
    await open(page, process.env.E2E_COLORS!, ['red.mp4', 'blue.mp4']);
    const { red, blue, R } = await placeRedAndBlue(page);

    // baseline: red then blue, a hard cut
    expect(isRed(await colorAt(page, 1))).toBe(true);
    expect(isBlue(await colorAt(page, 3))).toBe(true);
    const mid = await colorAt(page, 2.25);
    expect(isBlue(mid)).toBe(true);

    // --- transition: select the red clip, pick Cross dissolve
    await select(page, red);
    await page.getByRole('tab', { name: 'Transitions' }).click();
    await page.getByRole('button', { name: /Cross dissolve/ }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as Hook).__cutroom.useApp.getState().sequence.tracks.find((t) => t.name === 'V1')!.transitions.map((t) => t.type)))).toEqual(['dissolve']);
    const tr = await page.evaluate(() => (window as unknown as Hook).__cutroom.useApp.getState().sequence.tracks.find((t) => t.name === 'V1')!.transitions[0]!);
    expect(tr.duration).toBe(R); // 1 s, the default — there was enough footage
    // window is 1.5 s … 2.5 s around the cut at 2 s
    expect(isRed(await colorAt(page, 1.4))).toBe(true);
    const half = await colorAt(page, 2.0); // progress 0.5: an even mix of red and blue
    expect(half[0]!).toBeGreaterThan(90);
    expect(half[0]!).toBeLessThan(165);
    expect(half[2]!).toBeGreaterThan(90);
    expect(half[2]!).toBeLessThan(165);
    expect(half[1]!).toBeLessThan(40);
    const early = await colorAt(page, 1.75); // progress 0.25: mostly red
    expect(early[0]!).toBeGreaterThan(early[2]! + 60);
    const late = await colorAt(page, 2.25); // progress 0.75: mostly blue
    expect(late[2]!).toBeGreaterThan(late[0]! + 60);
    expect(isBlue(await colorAt(page, 2.6))).toBe(true);

    // --- a transition that has no spare footage is refused with the reason
    await select(page, blue);
    await page.getByRole('button', { name: /Wipe left/ }).click();
    await expect(page.getByText(/touches another|no spare footage|trim them shorter/)).toBeVisible();

    // --- effect: Color with saturation 0 turns the blue clip grey
    await select(page, blue);
    await page.getByRole('tab', { name: 'Effects' }).click();
    await page.getByRole('button', { name: /^Color/ }).click();
    const sat = page.getByLabel('Saturation', { exact: true });
    await sat.fill('0');
    await sat.press('Enter');
    await expect.poll(async () => (await colorAt(page, 3)).join(',')).toMatch(/^(\d+),(\d+),(\d+),255$/);
    const grey = await colorAt(page, 3);
    expect(Math.max(...grey.slice(0, 3)) - Math.min(...grey.slice(0, 3))).toBeLessThan(14); // R≈G≈B
    expect(grey[2]!).toBeLessThan(80);
    // and it can be switched off again
    await page.getByRole('button', { name: 'Disable Color' }).click();
    await expect.poll(async () => isBlue(await colorAt(page, 3))).toBe(true);

    // --- keyframes: opacity of the red clip animates from 100 % to 0 %
    await select(page, red);
    await page.evaluate(([t, rate]) => {
      const h = (window as unknown as Hook).__cutroom;
      h.useTimeline.getState().setPlayhead((t as number) * (rate as number), h.useApp.getState().sequence);
    }, [0.2, R]);
    await page.getByRole('button', { name: 'Add keyframe' }).nth(4).click(); // order: X, Y, Scale, Rotate, Opacity
    await page.evaluate(([t, rate]) => {
      const h = (window as unknown as Hook).__cutroom;
      h.useTimeline.getState().setPlayhead((t as number) * (rate as number), h.useApp.getState().sequence);
    }, [1.2, R]);
    const opacity = page.getByLabel('Opacity', { exact: true });
    await opacity.fill('0');
    await opacity.press('Enter');
    const seqNow = (await getSeq(page)).sequence.tracks.find((t) => t.name === 'V1')!;
    const redClip = Object.values(seqNow.items).find((c) => c.id === red) as unknown as { keyframes: Record<string, { time: number; value: number }[]> };
    expect(redClip.keyframes.opacity.map((k) => k.value)).toEqual([1, 0]);
    const start = await colorAt(page, 0.2); // first keyframe: fully red
    expect(start[0]!).toBeGreaterThan(200);
    const midway = await colorAt(page, 0.7); // halfway between keyframes: ~50 % red over black
    expect(midway[0]!).toBeGreaterThan(95);
    expect(midway[0]!).toBeLessThan(165);
    const end = await colorAt(page, 1.2); // second keyframe: invisible
    expect(end[0]!).toBeLessThan(25);
  });
});

test.describe('captions', () => {
  test.beforeEach(async ({ request }) => {
    await resetProject(request);
  });

  test('generate captions from the transcript, see them in the monitor, restyle, edit and clean up', async ({ page }) => {
    await open(page, process.env.E2E_FOOTAGE!, ['interview.mp4']);
    await page.waitForFunction(() => Object.values((window as unknown as Hook).__cutroom.useApp.getState().media).some((m) => m.name === 'interview.mp4' && m.status.transcript === 'done'), undefined, { timeout: 60_000 });
    await page.getByRole('listbox', { name: 'Media' }).getByRole('option', { name: /interview\.mp4/ }).click();
    await page.keyboard.press(',');
    await page.getByRole('button', { name: 'Program', exact: true }).click();
    const seq = (await getSeq(page)).sequence as unknown as { tracks: { name: string; items: Record<string, { id: string }> }[] };
    const clipId = Object.values(seq.tracks.find((t) => t.name === 'V1')!.items)[0]!.id;
    await select(page, clipId);

    await page.getByRole('tab', { name: 'Captions' }).click();
    await page.getByRole('radio', { name: /Bold pop/ }).click();
    await page.getByRole('button', { name: 'Generate from transcript' }).click();
    const list = page.getByRole('list', { name: 'Captions on the timeline' });
    await expect(list.getByRole('textbox')).toHaveCount(2);
    await expect(list.getByRole('textbox').first()).toHaveValue('Hello there.');
    await expect(list.getByRole('textbox').nth(1)).toHaveValue('Second beep arrives.');
    const caps = await page.evaluate(() => (window as unknown as Hook).__cutroom.useApp.getState().sequence.tracks.filter((t) => t.kind === 'caption').flatMap((t) => Object.values(t.items)));
    expect(caps.map((c) => c.styleId)).toEqual(['bold-pop', 'bold-pop']);

    // burned in: white text pixels in the lower third while a caption is up, none before the first word
    const hasText = (seconds: number) =>
      page.evaluate(async (s) => {
        const h = (window as unknown as Hook).__cutroom;
        const q = h.useApp.getState().sequence;
        h.useTimeline.getState().setPlayhead(s * q.timebase.rate, q);
        h.viewer.request();
        await h.viewer.idle();
        let bright = 0;
        for (let y = Math.round(q.height * 0.55); y < q.height * 0.9; y += 4) for (let x = Math.round(q.width * 0.2); x < q.width * 0.8; x += 4) {
          const p = h.viewer.pixel(x, y);
          if (p[0]! > 200 && p[1]! > 200 && p[2]! > 200) bright++;
        }
        return bright;
      }, seconds);
    expect(await hasText(0.5)).toBe(0);
    expect(await hasText(1.2)).toBeGreaterThan(20);
    expect(await hasText(3.5)).toBe(0); // between the two captions
    expect(await hasText(2.5)).toBeGreaterThan(20);

    // restyle all captions
    await page.getByRole('radio', { name: /Minimal/ }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as Hook).__cutroom.useApp.getState().sequence.tracks.filter((t) => t.kind === 'caption').flatMap((t) => Object.values(t.items)).map((c) => c.styleId)))).toEqual(['minimal', 'minimal']);

    // edit text in the list
    const first = list.getByRole('textbox').first();
    await first.fill('Hi folks.');
    await first.press('Enter');
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as Hook).__cutroom.useApp.getState().sequence.tracks.filter((t) => t.kind === 'caption').flatMap((t) => Object.values(t.items)).length))).toBe(2);
    await expect(list.getByRole('textbox').first()).toHaveValue('Hi folks.');

    // delete one
    await list.getByRole('button', { name: 'Delete caption' }).first().click();
    await expect(list.getByRole('textbox')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /SRT/ })).toBeVisible();
  });
});
