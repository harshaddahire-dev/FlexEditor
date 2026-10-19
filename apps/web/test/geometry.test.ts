import { describe, expect, it } from 'vitest';
import { Editor, buildClip, createSequence, type Sequence, type MediaRef } from '@cutroom/core';
import { HEADER_W, clampView, contentHeight, displayOrder, fitView, hitTest, rulerTicks, snapPoints, snapTicks, ticksToX, trackRows, visibleItems, xToTicks, zoomAt, type View } from '../src/timeline/geometry';

const media: Record<string, MediaRef> = { av: { id: 'av', kind: 'video', duration: 48000 * 600, hasVideo: true, hasAudio: true } };
const env = { getMedia: (id: string) => media[id] };
const seqWith = (clips: [number, number][], fps = { num: 30, den: 1 }): Sequence => {
  const ed = new Editor(createSequence({ width: 1920, height: 1080, fps }), env);
  const F = ed.state.timebase.rate / 30;
  for (const [start, len] of clips) {
    ed.apply({ type: 'overwrite', at: start * F, clips: [{ trackId: 't1', mediaId: 'av', sourceIn: 0, sourceOut: len * F }] });
  }
  return ed.state;
};
const view = (o: Partial<View> = {}): View => ({ pps: 100, scrollX: 0, scrollY: 0, width: 1000, height: 300, ...o });

describe('layout', () => {
  it('orders tracks: captions, graphics, video (top = highest), then audio', () => {
    const ed = new Editor(createSequence({ width: 1, height: 1, fps: { num: 30, den: 1 } }), env);
    ed.apply({ type: 'addTrack', kind: 'caption' });
    ed.apply({ type: 'addTrack', kind: 'graphics' });
    expect(displayOrder(ed.state).map((t) => t.name)).toEqual(['C1', 'G1', 'V2', 'V1', 'A1', 'A2']);
    const rows = trackRows(ed.state);
    expect(rows[0]!.y).toBe(0);
    expect(rows[1]!.y).toBe(rows[0]!.h + 1);
    expect(contentHeight(rows)).toBe(rows.at(-1)!.y + rows.at(-1)!.h);
  });

  it('time ↔ pixel round-trips and honours scroll', () => {
    const v = view({ pps: 250, scrollX: 400 });
    const rate = 48000;
    for (const t of [0, 1234, 48000, 123456789]) expect(xToTicks(ticksToX(t, rate, v), rate, v)).toBeCloseTo(t, 3);
    expect(ticksToX(48000 * 2, rate, v)).toBe(100); // 2 s × 250 px − 400 px scroll
  });

  it('zoom keeps the time under the cursor fixed and clamps', () => {
    const v = view({ pps: 100, scrollX: 300 });
    const z = zoomAt(v, 200, 2);
    expect((200 + z.scrollX) / z.pps).toBeCloseTo((200 + v.scrollX) / v.pps, 9);
    expect(zoomAt(v, 0, 1e9).pps).toBeLessThanOrEqual(20_000);
    expect(zoomAt(v, 0, 1e-9).pps).toBeGreaterThanOrEqual(0.5);
  });

  it('fit shows the whole sequence; scroll is clamped to content', () => {
    const seq = seqWith([[0, 3000]]); // 100 s
    const f = fitView(seq, 3000 * (48000 / 30), view({ width: 1000 }));
    expect(f.pps).toBeCloseTo(9.4, 1);
    const c = clampView(view({ scrollX: 1e9, scrollY: 1e9 }), 48000 * 10, 48000, 100);
    expect(c.scrollX).toBeLessThan(1e9);
    expect(c.scrollY).toBe(0); // content is shorter than the viewport
  });
});

describe('ruler', () => {
  const seq = seqWith([[0, 30]]);
  it('labels seconds when zoomed out and frames when zoomed in, never closer than the minimum spacing', () => {
    const out = rulerTicks(seq, view({ pps: 20 }));
    expect(out.major.length).toBeGreaterThan(1);
    const gaps = out.major.slice(1).map((t, i) => t.x - out.major[i]!.x);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(96);
    expect(out.major[1]!.label).toMatch(/^00:00:\d\d:00$/);
    const inn = rulerTicks(seq, view({ pps: 3000 }));
    const stepTicks = inn.major[1]!.ticks - inn.major[0]!.ticks;
    expect(stepTicks).toBeLessThan(48000); // sub-second steps
    expect(inn.major[1]!.label).toMatch(/:\d\d$/);
  });
  it('minor ticks subdivide the major step', () => {
    const t = rulerTicks(seq, view({ pps: 200 }));
    expect(t.minor.length).toBeGreaterThan(t.major.length);
  });
  it('uses drop-frame labels at 29.97', () => {
    const s = seqWith([[0, 30]], { num: 30000, den: 1001 });
    const t = rulerTicks(s, view({ pps: 100 }));
    expect(t.major.every((m) => m.label!.includes(';'))).toBe(true);
  });
});

describe('hit testing', () => {
  const seq = seqWith([[0, 60], [90, 60]]); // clips at 0–2 s and 3–5 s on V1
  const rows = trackRows(seq);
  const v1y = rows.find((r) => r.track.name === 'V1')!.y + 5;
  const px = (sec: number) => sec * 100;

  it('finds the clip body, its edges, empty lane space, the ruler and tracks', () => {
    const body = hitTest(seq, view(), px(1), v1y);
    expect(body).toMatchObject({ kind: 'clip', part: 'body' });
    expect(hitTest(seq, view(), px(2) - 3, v1y)).toMatchObject({ kind: 'clip', part: 'end' });
    expect(hitTest(seq, view(), px(3) + 3, v1y)).toMatchObject({ kind: 'clip', part: 'start' });
    expect(hitTest(seq, view(), px(2.5), v1y)).toMatchObject({ kind: 'lane' });
    expect(hitTest(seq, view(), px(1), -10)).toMatchObject({ kind: 'ruler' });
    expect(hitTest(seq, view(), px(1), 9999)).toEqual({ kind: 'none' });
  });

  it('prefers the nearer edge at a butt cut and still grabs an edge from just outside the clip', () => {
    const touching = seqWith([[0, 60], [60, 60]]);
    const y = trackRows(touching).find((r) => r.track.name === 'V1')!.y + 5;
    expect(hitTest(touching, view(), px(2) - 2, y)).toMatchObject({ part: 'end', item: { start: 0 } });
    expect(hitTest(touching, view(), px(2) + 2, y)).toMatchObject({ part: 'start' });
    expect(hitTest(seq, view(), px(2) + 4, v1y)).toMatchObject({ kind: 'clip', part: 'end' }); // 4 px right of the cut
  });

  it('keeps the body of very short clips grabbable', () => {
    const tiny = seqWith([[0, 3]]); // 3 frames = 0.1 s = 10 px at 100 pps
    const y = trackRows(tiny).find((r) => r.track.name === 'V1')!.y + 5;
    expect(hitTest(tiny, view(), 1, y)).toMatchObject({ part: 'start' });
    expect(hitTest(tiny, view(), 9, y)).toMatchObject({ part: 'end' });
  });

  it('finds markers on the ruler', () => {
    const ed = new Editor(seq, env);
    ed.apply({ type: 'addMarker', time: 48000 * 4, label: 'm' });
    expect(hitTest(ed.state, view(), px(4) + 2, -5)).toMatchObject({ kind: 'marker' });
  });

  it('reports the timeline position of the hit', () => {
    const h = hitTest(seq, view({ scrollX: 100 }), 50, v1y);
    expect(h).toMatchObject({ kind: 'clip' });
    expect((h as { ticks: number }).ticks).toBeCloseTo(48000 * 1.5, 0);
  });
});

describe('virtualisation', () => {
  it('visibleItems returns only items in range, in O(log n + visible) for a 5,000-clip track', () => {
    const ed = new Editor(createSequence({ width: 1, height: 1, fps: { num: 30, den: 1 } }), env);
    let seq = ed.state;
    // build 5,000 clips directly: 1 s clips back to back
    seq = structuredClone(seq);
    const track = seq.tracks.find((t) => t.name === 'V1')!;
    for (let i = 0; i < 5000; i++) track.items[`c${i}`] = buildClip(`c${i}`, { mediaId: 'av', trackId: track.id, start: i * 48000, duration: 48000, sourceIn: 0 });
    const vis = visibleItems(track, 2500 * 48000 + 100, 2503 * 48000 - 100);
    expect(vis.map((i) => i.id)).toEqual(['c2500', 'c2501', 'c2502']);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) visibleItems(track, (i % 4000) * 48000, (i % 4000 + 3) * 48000);
    expect(performance.now() - t0).toBeLessThan(150); // memoised order + binary search: ~µs per call
  });
});

describe('snapping', () => {
  const seq = seqWith([[0, 60], [90, 60]]);
  const rate = seq.timebase.rate;
  it('collects clip edges, markers, playhead and zero; excludes dragged items', () => {
    const pts = snapPoints(seq, 48000 * 10, [123]);
    expect(pts).toEqual([...pts].sort((a, b) => a - b));
    expect(pts).toEqual(expect.arrayContaining([0, 123, 48000 * 2, 48000 * 3, 48000 * 5, 48000 * 10]));
    const first = Object.keys(seq.tracks.find((t) => t.name === 'V1')!.items)[0]!;
    expect(snapPoints(seq, 0, [], new Set([first]))).not.toContain(48000 * 2);
  });
  it('snaps within the pixel threshold only, to the nearest point', () => {
    const pts = snapPoints(seq, 0);
    const pps = 100;
    const t = 48000 * 2 + (5 / pps) * rate; // 5 px past the edge at 2 s
    expect(snapTicks(t, pts, rate, pps)).toEqual({ ticks: 48000 * 2, snappedTo: 48000 * 2 });
    const far = 48000 * 2 + (20 / pps) * rate;
    expect(snapTicks(far, pts, rate, pps)).toEqual({ ticks: far, snappedTo: null });
    expect(snapTicks(t, [], rate, pps).snappedTo).toBeNull();
  });
  it('threshold is in pixels: zooming in makes snapping finer', () => {
    const pts = [48000 * 2];
    const t = 48000 * 2 + 480; // 10 ms past
    expect(snapTicks(t, pts, rate, 100).snappedTo).not.toBeNull(); // 1 px at 100 pps
    expect(snapTicks(t, pts, rate, 5000).snappedTo).toBeNull(); // 50 px at 5000 pps
  });
});

describe('header constant', () => {
  it('is wide enough for M/S/L buttons', () => expect(HEADER_W).toBeGreaterThanOrEqual(120));
});
