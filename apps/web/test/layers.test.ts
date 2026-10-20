import { describe, expect, it } from 'vitest';
import { buildClip, createSequence, defaultTransform, type Clip, type Sequence } from '@cutroom/core';
import { applyAffine, activeCaptions, activeVideoClips, layerMatrix, planFrame, resolveTransform, sourceTicksAt } from '../src/playback/layers';

const near = (a: [number, number], b: [number, number]) => {
  expect(a[0]).toBeCloseTo(b[0], 6);
  expect(a[1]).toBeCloseTo(b[1], 6);
};

describe('layerMatrix', () => {
  it('fills the frame when aspect ratios match', () => {
    const m = layerMatrix(defaultTransform(), 640, 360, 1920, 1080);
    near(applyAffine(m, 0, 0), [0, 0]);
    near(applyAffine(m, 1, 1), [1920, 1080]);
  });

  it('letterboxes a narrower source (contain fit)', () => {
    const m = layerMatrix(defaultTransform(), 1080, 1920, 1920, 1080);
    near(applyAffine(m, 0, 0), [(1920 - 607.5) / 2, 0]);
    near(applyAffine(m, 1, 1), [(1920 + 607.5) / 2, 1080]);
  });

  it('scales about the anchor and translates from the centre', () => {
    const t = { ...defaultTransform(), scale: { x: 0.5, y: 0.5 }, position: { x: 100, y: -50 } };
    const m = layerMatrix(t, 1920, 1080, 1920, 1080);
    near(applyAffine(m, 0.5, 0.5), [960 + 100, 540 - 50]);
    near(applyAffine(m, 0, 0), [960 + 100 - 480, 540 - 50 - 270]);
    // a top-left anchor keeps that corner fixed
    const m2 = layerMatrix({ ...t, anchor: { x: 0, y: 0 } }, 1920, 1080, 1920, 1080);
    near(applyAffine(m2, 0, 0), [960 + 100, 540 - 50]);
  });

  it('rotates clockwise on screen', () => {
    const t = { ...defaultTransform(), rotation: 90 };
    const m = layerMatrix(t, 100, 100, 100, 100);
    // the top-left corner of a square rotated 90° clockwise about its centre lands at top-right
    near(applyAffine(m, 0, 0), [100, 0]);
    near(applyAffine(m, 1, 0), [100, 100]);
  });
});

describe('frame resolution', () => {
  const seq: Sequence = createSequence({ width: 1920, height: 1080, fps: { num: 30, den: 1 } });
  const rate = seq.timebase.rate;
  const clip = (over: Partial<Clip>): Clip => ({ ...buildClip('c1', { mediaId: 'm', trackId: 't1', start: 0, duration: rate, sourceIn: 0 }), ...over });

  it('maps timeline ticks to source ticks including speed and trim', () => {
    const c = clip({ start: 2 * rate, sourceIn: rate, speed: { num: 2, den: 1 } });
    expect(sourceTicksAt(c, 2 * rate)).toBe(rate);
    expect(sourceTicksAt(c, 2 * rate + 1600)).toBe(rate + 3200);
    expect(sourceTicksAt(clip({ speed: { num: 1, den: 3 } }), 1600)).toBe(Math.floor(1600 / 3));
  });

  it('evaluates keyframes in clip time', () => {
    const c = clip({ keyframes: { opacity: [{ time: 0, value: 0, interpolation: 'linear' }, { time: 1000, value: 1, interpolation: 'linear' }] } });
    expect(resolveTransform(c, 500).opacity).toBeCloseTo(0.5, 6);
    expect(resolveTransform(c, 5000).opacity).toBe(1);
    expect(resolveTransform(c, 0).position).toEqual({ x: 0, y: 0 });
  });

  it('selects clips half-open and stacks V1 below V2, skipping disabled clips', () => {
    const s: Sequence = structuredClone(seq);
    const v1 = s.tracks.find((t) => t.name === 'V1')!;
    const v2 = s.tracks.find((t) => t.name === 'V2')!;
    v1.items.a = clip({ id: 'a', trackId: v1.id, start: 0, duration: 1600 });
    v1.items.b = clip({ id: 'b', trackId: v1.id, start: 1600, duration: 1600 });
    v2.items.c = clip({ id: 'c', trackId: v2.id, start: 0, duration: 3200, enabled: false });
    expect(activeVideoClips(s, 0).map((l) => l.clip.id)).toEqual(['a']);
    expect(activeVideoClips(s, 1599).map((l) => l.clip.id)).toEqual(['a']);
    expect(activeVideoClips(s, 1600).map((l) => l.clip.id)).toEqual(['b']);
    expect(activeVideoClips(s, 3200)).toEqual([]);
    v2.items.c!.enabled = true;
    expect(activeVideoClips(s, 1600).map((l) => l.clip.id)).toEqual(['b', 'c']);
  });
});

describe('planFrame — transitions', () => {
  const seq: Sequence = createSequence({ width: 1920, height: 1080, fps: { num: 30, den: 1 } });
  const R = seq.timebase.rate;
  const v1 = seq.tracks.find((t) => t.name === 'V1')!;
  const a = buildClip('a', { mediaId: 'm', trackId: v1.id, start: 0, duration: 3 * R, sourceIn: 0 });
  const b = buildClip('b', { mediaId: 'm', trackId: v1.id, start: 3 * R, duration: 3 * R, sourceIn: 0 });
  v1.items.a = a;
  v1.items.b = b;
  const tr = (alignment: 'center' | 'start' | 'end') => ({ id: 'x1', type: 'dissolve', duration: R, alignment, params: {}, betweenClipIds: ['a', 'b'] as [string, string] });

  it('outside the window the clips play normally; the cut is half-open', () => {
    v1.transitions = [tr('center')];
    expect(planFrame(seq, R).map((p) => p.kind)).toEqual(['clip']);
    expect(planFrame(seq, 2.5 * R - 1).map((p) => p.kind)).toEqual(['clip']);
    expect(planFrame(seq, 3.5 * R).map((p) => (p.kind === 'clip' ? p.clip.id : 'T'))).toEqual(['clip'].map(() => 'b'));
  });

  it('inside the window both clips become one transition item with progress 0→1', () => {
    v1.transitions = [tr('center')];
    const at = (t: number) => planFrame(seq, t)[0]!;
    const s = at(2.5 * R);
    expect(s).toMatchObject({ kind: 'transition', progress: 0 });
    expect(at(3 * R)).toMatchObject({ kind: 'transition', progress: 0.5 });
    expect((at(3.25 * R) as { progress: number }).progress).toBeCloseTo(0.75, 9);
    expect(planFrame(seq, 3 * R)).toHaveLength(1); // not drawn twice
    const t = at(3 * R) as Extract<ReturnType<typeof planFrame>[number], { kind: 'transition' }>;
    expect([t.from.id, t.to.id]).toEqual(['a', 'b']);
  });

  it('start and end alignment move the window to one side of the cut', () => {
    v1.transitions = [tr('start')];
    expect(planFrame(seq, 2.99 * R)[0]!.kind).toBe('clip');
    expect(planFrame(seq, 3 * R)[0]).toMatchObject({ kind: 'transition', progress: 0 });
    expect(planFrame(seq, 4 * R)[0]!.kind).toBe('clip');
    v1.transitions = [tr('end')];
    expect(planFrame(seq, 2 * R)[0]).toMatchObject({ kind: 'transition', progress: 0 });
    expect(planFrame(seq, 3 * R)[0]!.kind).toBe('clip');
  });

  it('a hidden track or a disabled clip is not planned', () => {
    v1.transitions = [];
    v1.muted = true;
    expect(planFrame(seq, R)).toEqual([]);
    v1.muted = false;
    a.enabled = false;
    expect(planFrame(seq, R)).toEqual([]);
    a.enabled = true;
  });
});

describe('activeCaptions', () => {
  it('returns captions on screen, half-open, from caption tracks only', () => {
    const seq: Sequence = createSequence({ width: 1920, height: 1080, fps: { num: 30, den: 1 } });
    const R = seq.timebase.rate;
    seq.tracks.push({ id: 'tc', kind: 'caption', name: 'C1', locked: false, muted: false, solo: false, height: 32, crossfadeMs: 0, transitions: [], items: { p1: { kind: 'caption', id: 'p1', trackId: 'tc', start: R, duration: R, words: [], styleId: 'default', createdBy: 'user', accepted: true } } });
    expect(activeCaptions(seq, 0)).toEqual([]);
    expect(activeCaptions(seq, R).map((x) => x.caption.id)).toEqual(['p1']);
    expect(activeCaptions(seq, 2 * R - 1)).toHaveLength(1);
    expect(activeCaptions(seq, 2 * R)).toEqual([]);
  });
});
