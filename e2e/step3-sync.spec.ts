import { expect, test, type Page } from '@playwright/test';
import { clipsOn, edit, getSeq, openFootageAndInsert, resetProject, scan, undo } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

type Hook = { __cutroom: { audio: { renderOnsets(): Promise<{ onsets: number[]; peak: number; samples: number }>; engine: { running: boolean; levels(): number[]; position(): number } }; useTimeline: { getState(): { playhead: number; playing: boolean } } } };

/** Where the picture flashes and where the sound beeps, measured through the real playback paths. */
async function measure(page: Page, frames: number) {
  const { frame, out } = await scan(page, frames);
  const rate = (await getSeq(page)).sequence.timebase.rate;
  const flashes = out.filter((f) => f.white).map((f) => (f.n * frame) / rate);
  const r = await page.evaluate(() => (window as unknown as Hook).__cutroom.audio.renderOnsets());
  return { flashes, onsets: r.onsets, peak: r.peak, samples: r.samples };
}

/** Pair each flash with the beep that starts nearest to it and return (beep − flash) in samples. */
function offsets(m: { flashes: number[]; onsets: number[] }, skipBefore = 0.01): number[] {
  return m.flashes
    .filter((t) => t >= skipBefore) // the very first beep sits under the clip's de-click fade-in
    .map((t) => {
      const near = m.onsets.reduce((best, o) => (Math.abs(o - t) < Math.abs(best - t) ? o : best), Number.POSITIVE_INFINITY);
      expect(Math.abs(near - t), `no beep near the flash at ${t}s`).toBeLessThan(0.1);
      return (near - t) * 48_000;
    });
}

test('flash and beep stay on the same instant after split, trim, ripple and speed changes', async ({ page }) => {
  test.setTimeout(240_000);
  await openFootageAndInsert(page);
  const F = (await getSeq(page)).sequence.timebase.rate / 30;

  // untouched: the reference. The beep detector fires ≤ a couple of samples after the true onset, so we compare
  // every edit against this baseline and, separately, require the baseline itself to be within 1 ms.
  const base = await measure(page, 184);
  expect(base.peak).toBeGreaterThan(0.3);
  const b0 = offsets(base);
  expect(b0.length).toBeGreaterThanOrEqual(5);
  const ref = b0.reduce((a, b) => a + b, 0) / b0.length;
  expect(Math.max(...b0.map((x) => Math.abs(x - ref)))).toBeLessThanOrEqual(1);
  expect(Math.abs(ref)).toBeLessThan(48); // < 1 ms; a frame is 1600 samples
  console.log(`baseline beep−flash: ${ref.toFixed(2)} samples (spread ≤ 1) over ${b0.length} flashes`);

  // negative control: the measurement must see a deliberate 2-frame slip of the audio alone
  {
    const s0 = await getSeq(page);
    const a1 = clipsOn(s0, 'A1')[0]!;
    await edit(page, [{ type: 'trim', clipId: a1.id, edge: 'end', to: 170 * F, linked: false }], 'trim audio only'); // slack for the slip
    await edit(page, [{ type: 'slip', clipId: clipsOn(s0, 'A1')[0]!.id, delta: 2 * F, linked: false }], 'slip audio 2 frames');
    const o = offsets(await measure(page, 184), 0.2);
    for (const x of o) expect(Math.abs(Math.abs(x - ref) - 3200)).toBeLessThanOrEqual(2);
    await undo(page);
    await undo(page);
  }

  const proof = async (label: string, frames: number, tolSamples: number) => {
    const m = await measure(page, frames);
    const o = offsets(m);
    expect(o.length, `${label}: flashes seen`).toBeGreaterThanOrEqual(2);
    console.log(`${label}: offsets vs baseline (samples) = ${o.map((x) => (x - ref).toFixed(2)).join(', ')}`);
    for (const x of o) expect(Math.abs(x - ref), `${label}: beep−flash drifted by ${(x - ref).toFixed(2)} samples`).toBeLessThanOrEqual(tolSamples);
  };

  // split + move the right half later is not a sync edit (they stay linked); ripple-delete the middle instead
  let s = await getSeq(page);
  await edit(page, [{ type: 'split', clipId: clipsOn(s, 'V1')[0]!.id, at: 75 * F }], 'split');
  s = await getSeq(page);
  await edit(page, [{ type: 'split', clipId: clipsOn(s, 'V1')[1]!.id, at: 135 * F }], 'split');
  s = await getSeq(page);
  await edit(page, [{ type: 'rippleDelete', clipIds: [clipsOn(s, 'V1')[1]!.id] }], 'ripple delete');
  await proof('after split + ripple delete', 124, 1);
  await undo(page);
  await undo(page);
  await undo(page);

  s = await getSeq(page);
  await edit(page, [{ type: 'rippleTrim', clipId: clipsOn(s, 'V1')[0]!.id, edge: 'start', to: 15 * F }], 'ripple trim');
  await proof('after ripple trim', 170, 1);
  await undo(page);

  s = await getSeq(page);
  await edit(page, [{ type: 'trim', clipId: clipsOn(s, 'V1')[0]!.id, edge: 'end', to: 100 * F }], 'trim end');
  await proof('after trim', 104, 1);
  await undo(page);

  s = await getSeq(page);
  await edit(page, [{ type: 'setSpeed', clipId: clipsOn(s, 'V1')[0]!.id, speed: { num: 2, den: 1 } }], 'speed 2x');
  await proof('after 2× speed', 94, 3);
});

test('playback is clocked by the audio device and the playhead follows what is heard', async ({ page }) => {
  await openFootageAndInsert(page);
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as unknown as Hook).__cutroom.audio.engine.running);

  // sample the meter for a while: there is a beep at 0 s and 1 s, so the signal must show up
  const seen = await page.evaluate(async () => {
    const h = (window as unknown as Hook).__cutroom;
    let peak = Number.NEGATIVE_INFINITY;
    const t0 = performance.now();
    while (performance.now() - t0 < 1300) {
      peak = Math.max(peak, ...h.audio.engine.levels());
      await new Promise((r) => setTimeout(r, 10));
    }
    return { peak, playhead: h.useTimeline.getState().playhead, heard: h.audio.engine.position() };
  });
  expect(seen.peak).toBeGreaterThan(-20);

  const rate = (await getSeq(page)).sequence.timebase.rate;
  const frame = rate / 30;
  expect(seen.playhead % frame).toBe(0);
  // ~1.3 s of wall time ≈ 1.3 s of timeline (generous: CI jitter and the 60 ms start lead)
  expect(seen.playhead / rate).toBeGreaterThan(0.7);
  expect(seen.playhead / rate).toBeLessThan(1.5);
  // never ahead of the audio, and at most ~a frame (plus a rAF) behind it
  expect(seen.playhead).toBeLessThanOrEqual(seen.heard);

  await page.keyboard.press('Space');
  await page.waitForFunction(() => !(window as unknown as Hook).__cutroom.audio.engine.running);
  const stopped = await page.evaluate(() => (window as unknown as Hook).__cutroom.useTimeline.getState());
  expect(stopped.playing).toBe(false);
});
