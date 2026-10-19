import { describe, expect, it } from 'vitest';
import { buildClip, createSequence, defaultTransform, type Clip, type Sequence } from '@cutroom/core';
import { applyAffine, activeVideoClips, layerMatrix, resolveTransform, sourceTicksAt } from '../src/playback/layers';

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
