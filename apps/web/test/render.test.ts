import { describe, expect, it } from 'vitest';
import { buildClip, createSequence, type Sequence } from '@cutroom/core';
import { drawTimeline, type DrawParams, type Theme } from '../src/timeline/render';

/** A canvas context that records calls instead of drawing. */
function recorder() {
  const calls: Record<string, number> = {};
  const texts: string[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === 'measureText') return () => ({ width: 0 });
      return (...args: unknown[]) => {
        calls[prop] = (calls[prop] ?? 0) + 1;
        if (prop === 'fillText') texts.push(String(args[0]));
      };
    },
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, texts };
}

const theme: Theme = Object.fromEntries(
  ['bg0', 'bg1', 'bg2', 'bg3', 'line', 'text1', 'text2', 'text3', 'accent', 'accentSoft', 'playhead', 'success', 'warn', 'danger', 'clipVideo', 'clipAudio', 'clipCaption', 'clipGraphics', 'fontUi', 'fontMono'].map((k) => [k, '#888']),
) as unknown as Theme;

function bigSequence(n: number): Sequence {
  const seq = createSequence({ width: 1920, height: 1080, fps: { num: 30, den: 1 } });
  const v = seq.tracks.find((t) => t.name === 'V1')!;
  for (let i = 0; i < n; i++) v.items[`c${i}`] = buildClip(`c${i}`, { mediaId: 'm', trackId: v.id, start: i * 48000, duration: 48000, sourceIn: 0, name: `clip ${i}` });
  return seq;
}

const params = (seq: Sequence, o: Partial<DrawParams> = {}): DrawParams => ({
  seq,
  view: { pps: 100, scrollX: 0, scrollY: 0, width: 800, height: 240 },
  theme,
  width: 800,
  height: 266,
  playhead: 0,
  inPoint: null,
  outPoint: null,
  selection: new Set(),
  ...o,
});

describe('drawTimeline', () => {
  it('only draws clips that are on screen — cost does not grow with clip count', () => {
    const small = recorder();
    drawTimeline(small.ctx, params(bigSequence(20), { view: { pps: 100, scrollX: 0, scrollY: 0, width: 800, height: 240 } }));
    const big = recorder();
    drawTimeline(big.ctx, params(bigSequence(5000), { view: { pps: 100, scrollX: 100 * 2500, scrollY: 0, width: 800, height: 240 } }));
    const labels = (t: string[]) => t.filter((x) => x.startsWith('clip '));
    expect(labels(big.texts).length).toBeLessThanOrEqual(10); // 800 px / 100 px per 1 s clip ≈ 8–9 on screen
    expect(labels(big.texts).length).toBeGreaterThanOrEqual(8);
    expect(labels(big.texts)[0]).toBe('clip 2500');
    expect(big.calls.roundRect ?? 0).toBeLessThanOrEqual((small.calls.roundRect ?? 0) + 30);
  });

  it('labels clips with their name, the playhead is drawn last, and agent clips get a badge', () => {
    const seq = bigSequence(3);
    const v = seq.tracks.find((t) => t.name === 'V1')!;
    v.items.c1 = { ...v.items.c1!, createdBy: 'agent:cutter', accepted: false } as never;
    const r = recorder();
    drawTimeline(r.ctx, params(seq, { playhead: 48000 * 1.5, selection: new Set(['c0']) }));
    expect(r.texts).toEqual(expect.arrayContaining(['clip 0', 'clip 1', 'clip 2', 'AI']));
    expect(r.calls.fill).toBeGreaterThan(0);
    expect(r.calls.stroke).toBeGreaterThan(0);
  });

  it('draws an empty sequence without throwing', () => {
    const r = recorder();
    expect(() => drawTimeline(r.ctx, params(createSequence({ width: 1, height: 1, fps: { num: 24, den: 1 } })))).not.toThrow();
  });
});


describe('review overlay (ghost diff)', () => {
  it('outlines removed items and the old position of moved/trimmed ones, only on tracks that exist', () => {
    const seq = bigSequence(3);
    const v1 = seq.tracks.find((t) => t.name === 'V1')!;
    const item = (id: string, start: number, trackId = v1.id) => ({ id, trackId, trackName: 'V1', kind: 'clip' as const, name: id, start, duration: 48000 });
    const diff = {
      added: [item('new', 0)],
      removed: [item('gone', 0), item('gone2', 48000), item('lost', 0, 'no-such-track')],
      changed: [
        { before: item('m', 96000), after: item('m', 144000), what: ['moved' as const] },
        { before: item('p', 0), after: item('p', 0), what: ['props' as const] },
      ],
    };
    const a = recorder();
    drawTimeline(a.ctx, params(seq, { review: null }));
    const b = recorder();
    drawTimeline(b.ctx, params(seq, { review: diff }));
    expect((b.calls.strokeRect ?? 0) - (a.calls.strokeRect ?? 0)).toBe(3); // 2 removed + 1 moved; props-only and unknown track draw nothing
  });
});
