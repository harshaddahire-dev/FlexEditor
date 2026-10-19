import { expect, test, type Page } from '@playwright/test';
import { getSeq, openFootageAndInsert, resetProject } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

type W = { __cutroom: { useApp: { getState(): { media: Record<string, { name: string; status: Record<string, string> }> } }; useTimeline: { getState(): { playhead: number; view: { pps: number; scrollX: number; scrollY: number } } } } };

async function analysisDone(page: Page) {
  await page.waitForFunction(() => {
    const m = Object.values((window as unknown as W).__cutroom.useApp.getState().media).find((x) => x.name === 'interview.mp4');
    return !!m && ['waveform', 'silences', 'loudness', 'beats', 'filmstrip', 'scenes', 'transcript'].every((k) => m.status[k] === 'done');
  }, undefined, { timeout: 60_000 });
}

/** Colour of one timeline pixel at (timeline seconds, track lane), from the real canvas. */
async function pixel(page: Page, seconds: number, lane: 'V1' | 'A1', dy = 0) {
  return page.evaluate(
    ({ seconds, lane, dy }) => {
      const w = window as unknown as W;
      const v = w.__cutroom.useTimeline.getState().view;
      const c = document.querySelector('[data-testid="timeline-canvas"]') as HTMLCanvasElement;
      const dpr = window.devicePixelRatio || 1;
      // lanes top→bottom: video tracks reversed (V2, V1), then audio; 1px separators, below the 26px ruler
      const seq = (window as unknown as { __cutroom: { useApp: { getState(): { sequence: { tracks: { name: string; kind: string; height: number }[] } } } } }).__cutroom.useApp.getState().sequence;
      const order = [...seq.tracks.filter((t) => t.kind === 'video').reverse(), ...seq.tracks.filter((t) => t.kind === 'audio')];
      let top = 26;
      for (const t of order) {
        if (t.name === lane) break;
        top += t.height + 1;
      }
      const h = order.find((t) => t.name === lane)!.height;
      const x = Math.round(seconds * v.pps - v.scrollX);
      const y = top + 15 + Math.floor((h - 15) / 2) + dy; // centre of the clip body, below its 15px header strip
      const d = c.getContext('2d')!.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    },
    { seconds, lane, dy },
  );
}

test('waveforms, filmstrip, loudness and transcript appear for imported media', async ({ page }) => {
  await openFootageAndInsert(page);
  await analysisDone(page);
  // let the canvas repaint with the loaded caches
  await page.waitForTimeout(500);

  // audio lane: bright waveform columns at the 50 ms beeps (t = 0, 1, 2 …), none in the quiet between
  const brightness = (p: number[]) => p[0]! + p[1]! + p[2]!;
  const colsAt = async (seconds: number) => {
    let bright = 0;
    for (let dy = -14; dy <= 14; dy += 2) if (Math.abs(dy) >= 4 && brightness(await pixel(page, seconds, 'A1', dy)) > 480) bright++;
    return bright;
  };
  // zoom so a 50 ms beep is several pixels wide
  await page.evaluate(() => {
    const s = (window as unknown as W).__cutroom.useTimeline.getState() as unknown as { setView(v: object, seq: unknown): void };
    s.setView({ pps: 400, scrollX: 0 }, (window as unknown as { __cutroom: { useApp: { getState(): { sequence: unknown } } } }).__cutroom.useApp.getState().sequence);
  });
  await page.waitForTimeout(300);
  expect(await colsAt(0.02)).toBeGreaterThan(3);
  expect(await colsAt(0.5)).toBe(0);

  // video lane: filmstrip tiles replaced the flat clip colour
  const flat = [52, 88, 140];
  const v = await pixel(page, 0.3, 'V1', 6);
  expect(Math.abs(v[0]! - flat[0]!) + Math.abs(v[1]! - flat[1]!) + Math.abs(v[2]! - flat[2]!)).toBeGreaterThan(40);

  // media info shows the analysis summary
  await page.getByRole('listbox', { name: 'Media' }).getByRole('option', { name: /interview\.mp4/ }).click();
  const info = page.getByRole('region', { name: 'Viewer' });
  await expect(info.getByText(/LUFS/)).toBeVisible();
  await expect(info.getByText(/gaps?/)).toBeVisible();
  await expect(info.getByText('5 words · en')).toBeVisible();

  // transcript: lines, search, click to seek
  await page.getByRole('tab', { name: 'Transcript' }).click();
  const list = page.getByRole('list', { name: 'Transcript' });
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(list.getByText('Hello there.')).toBeVisible();
  await page.getByLabel('Search transcript').fill('beep arrives');
  await expect(list.getByRole('button')).toHaveCount(1);
  await list.getByRole('button').click();
  const rate = (await getSeq(page)).sequence.timebase.rate;
  const head = await page.evaluate(() => (window as unknown as W).__cutroom.useTimeline.getState().playhead);
  expect(head).toBe(2 * rate); // "Second beep arrives." starts at 2.0 s of the media = 2.0 s on the timeline
});

test('transcript explains itself when the line is not on the timeline', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Project folder path').fill(process.env.E2E_FOOTAGE!);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const bin = page.getByRole('listbox', { name: 'Media' });
  await expect(bin.getByRole('option')).toHaveCount(3);
  await bin.getByRole('option', { name: /interview\.mp4/ }).click();
  await analysisDone(page);
  await page.getByRole('tab', { name: 'Transcript' }).click();
  await page.getByRole('list', { name: 'Transcript' }).getByRole('button').first().click(); // nothing on the timeline
  await expect(page.getByText('That moment is not on the timeline yet.')).toBeVisible();
});
