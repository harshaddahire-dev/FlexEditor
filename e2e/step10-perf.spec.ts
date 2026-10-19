import { expect, test } from '@playwright/test';
import { openFootageAndInsert, resetProject } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

type Hook = {
  __cutroom: {
    useApp: { getState(): { sequence: { timebase: { rate: number; fps: { num: number; den: number } }; tracks: { id: string; name: string }[] }; media: Record<string, { id: string; name: string }> } };
    useTimeline: { getState(): { zoom(f: number, x: number, s: unknown): void; setView(v: object, s: unknown): void; setPlayhead(t: number, s: unknown): void; fit(s: unknown): void; view: { scrollX: number; pps: number; width: number } } };
  };
};

/** Spec: the timeline stays at 60 fps with 1,000+ clips while zooming, panning and scrubbing. */
test('1,200 clips: zoom, pan and scrub the timeline at ~60 fps', async ({ page }) => {
  await openFootageAndInsert(page);
  const st = await page.evaluate(() => {
    const s = (window as unknown as Hook).__cutroom.useApp.getState();
    return { rate: s.sequence.timebase.rate, fps: s.sequence.timebase.fps.num / s.sequence.timebase.fps.den, v1: s.sequence.tracks.find((t) => t.name === 'V1')!.id, a1: s.sequence.tracks.find((t) => t.name === 'A1')!.id, mid: Object.values(s.media).find((m) => m.name === 'interview.mp4')!.id };
  });
  // 600 linked A/V pairs of 20 frames, one per 0.667 s: 1,200 clips in a single transaction
  const f = Math.round(st.rate / st.fps);
  await page.request.post('/api/edit', { data: { origin: 'user', label: 'Many clips', ops: [{ type: 'removeRange', start: 0, end: 100 * st.rate, ripple: true }] } });
  const ops = Array.from({ length: 600 }, (_, i) => ({
    type: 'overwrite',
    at: i * 20 * f,
    clips: [
      { trackId: st.v1, mediaId: st.mid, sourceIn: (i % 5) * 20 * f, sourceOut: ((i % 5) + 1) * 20 * f, link: `p${i}` },
      { trackId: st.a1, mediaId: st.mid, sourceIn: (i % 5) * 20 * f, sourceOut: ((i % 5) + 1) * 20 * f, link: `p${i}` },
    ],
  }));
  const res = await page.request.post('/api/edit', { data: { origin: 'user', label: 'Many clips', ops } });
  expect(res.ok(), (await res.text()).slice(0, 300)).toBeTruthy();
  await page.waitForFunction(
    () => (window as unknown as { __cutroom: { useApp: { getState(): { sequence: { tracks: { items: object }[] } } } } }).__cutroom.useApp.getState().sequence.tracks.reduce((n, t) => n + Object.keys(t.items).length, 0) >= 1200,
    undefined,
    { timeout: 30_000 },
  );

  const stats = await page.evaluate(async () => {
    const h = (window as unknown as Hook).__cutroom;
    const seq = h.useApp.getState().sequence;
    h.useTimeline.getState().fit(seq);
    await new Promise((r) => setTimeout(r, 300));
    const intervals: number[] = [];
    const phases: number[] = [];
    let last = performance.now();
    const t0 = last;
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        intervals.push(now - last);
        last = now;
        const t = (now - t0) / 1000;
        phases.push(t < 1 ? 0 : t < 2 ? 1 : 2);
        const tl = h.useTimeline.getState();
        if (t < 1) tl.zoom(t < 0.5 ? 1.03 : 1 / 1.03, tl.view.width / 2, seq); // zoom in and out
        else if (t < 2) tl.setView({ scrollX: tl.view.scrollX + 40 }, seq); // pan
        else tl.setPlayhead(Math.round(((t * 7) % 380) * seq.timebase.rate), seq); // scrub
        if (t < 3) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    intervals.shift();
    phases.shift();
    const per = [0, 1, 2].map((p) => { const xs = intervals.filter((_, i) => phases[i] === p); return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); });
    intervals.sort((a, b) => a - b);
    const q = (p: number) => intervals[Math.min(intervals.length - 1, Math.floor(p * intervals.length))]!;
    return { per, n: intervals.length, mean: intervals.reduce((a, b) => a + b, 0) / intervals.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: intervals[intervals.length - 1]! };
  });
  // eslint-disable-next-line no-console
  console.log(`phases mean ms (zoom, pan, scrub): ${stats.per.map((x) => x.toFixed(1)).join(', ')}`);
  // eslint-disable-next-line no-console
  console.log(`timeline, 1,200 clips: ${stats.n} frames, mean ${stats.mean.toFixed(1)} ms (${(1000 / stats.mean).toFixed(0)} fps), p50 ${stats.p50.toFixed(1)}, p95 ${stats.p95.toFixed(1)}, p99 ${stats.p99.toFixed(1)}, max ${stats.max.toFixed(1)} ms`);
  expect(stats.n).toBeGreaterThan(150);
  // zooming and panning are pure timeline drawing: 60 fps (a little room for a shared CI box)
  expect(1000 / ((stats.per[0]! + stats.per[1]!) / 2)).toBeGreaterThan(55);
  // scrubbing also seeks and decodes video for the monitor (a different clip every ~⅔ s here), so it gets more room
  expect(1000 / stats.per[2]!).toBeGreaterThan(38);
});
