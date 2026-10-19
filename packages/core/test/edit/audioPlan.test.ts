import { describe, expect, it } from 'vitest';
import { dbToGain, planAudio, rampGain } from '../../src';
import { clip, insertAV, rig, run } from './helpers';

describe('rampGain', () => {
  it('equal-power in/out ramps sum to constant power', () => {
    const inR = { from: 0, to: 100, shape: 'in', curve: 'equal-power' } as const;
    const outR = { ...inR, shape: 'out' } as const;
    for (let t = 0; t <= 100; t += 7) {
      const p = rampGain(inR, t) ** 2 + rampGain(outR, t) ** 2;
      expect(p).toBeCloseTo(1, 12);
    }
    expect(rampGain(inR, -5)).toBe(0);
    expect(rampGain(inR, 500)).toBe(1);
    expect(rampGain(outR, -5)).toBe(1);
    expect(rampGain(outR, 500)).toBe(0);
  });
  it('linear ramps are linear', () => {
    expect(rampGain({ from: 0, to: 10, shape: 'in', curve: 'linear' }, 5)).toBeCloseTo(0.5, 12);
  });
});

describe('planAudio', () => {
  it('gives each audio clip a voice with de-click edge fades and the clip gain', () => {
    const r = rig();
    const c = insertAV(r, 0, 10, 15);
    run(r, { type: 'setClipProps', clipId: c.a, patch: { audio: { gainDb: -6 } } } as never);
    const plan = planAudio(r.ed.state, r.env);
    expect(plan).toHaveLength(1);
    const v = plan[0]!;
    expect(v).toMatchObject({ clipId: c.a, mediaId: 'av', start: 0, end: r.f(150), sourceStart: r.f(300) });
    expect(v.gain).toBeCloseTo(dbToGain(-6), 12);
    const fadeMs = (rr: { from: number; to: number }) => ((rr.to - rr.from) / r.R) * 1000;
    expect(v.ramps.map((x) => [x.shape, x.curve, fadeMs(x)])).toEqual([['in', 'equal-power', 8], ['out', 'equal-power', 8]]);
  });

  it('a cut with handles on both sides becomes an 8 ms equal-power crossfade centred on the cut', () => {
    const r = rig();
    const a = insertAV(r, 0, 10, 15); // media 10..15 s
    const b = insertAV(r, 150, 30, 35); // media 30..35 s
    const plan = planAudio(r.ed.state, r.env);
    const va = plan.find((v) => v.clipId === a.a)!;
    const vb = plan.find((v) => v.clipId === b.a)!;
    const cut = r.f(150);
    const half = (8 / 1000) * r.R / 2;
    expect(va.end).toBe(cut + half);
    expect(vb.start).toBe(cut - half);
    // the incoming voice starts early, reading its head handle: same media time at the same timeline instant
    expect(vb.sourceStart).toBe(r.f(30 * 30) - half);
    expect(va.ramps.find((x) => x.from === cut - half)).toEqual({ from: cut - half, to: cut + half, shape: 'out', curve: 'equal-power' });
    expect(vb.ramps.find((x) => x.from === cut - half)).toEqual({ from: cut - half, to: cut + half, shape: 'in', curve: 'equal-power' });
  });

  it('a contiguous cut (same media, same mapping) is left alone', () => {
    const r = rig();
    const c = insertAV(r, 0, 10, 20);
    run(r, { type: 'split', clipId: c.a, at: r.f(100) });
    const plan = planAudio(r.ed.state, r.env);
    expect(plan).toHaveLength(2);
    const [first, second] = plan.sort((x, y) => x.start - y.start);
    expect(first!.end).toBe(second!.start);
    expect(first!.ramps).toHaveLength(1); // only the fade-in at the very start…
    expect(second!.ramps).toHaveLength(1); // …and the fade-out at the very end
  });

  it('honours mute and solo, and skips disabled clips', () => {
    const r = rig();
    const c = insertAV(r, 0, 0, 5);
    run(r, { type: 'setTrackProps', trackId: r.ids.A1, patch: { muted: true } } as never);
    expect(planAudio(r.ed.state, r.env)).toHaveLength(0);
    run(r, { type: 'setTrackProps', trackId: r.ids.A1, patch: { muted: false } } as never);
    run(r, { type: 'setTrackProps', trackId: r.ids.A2, patch: { solo: true } } as never);
    expect(planAudio(r.ed.state, r.env)).toHaveLength(0); // A1 is not soloed
    run(r, { type: 'setTrackProps', trackId: r.ids.A2, patch: { solo: false } } as never);
    run(r, { type: 'setClipProps', clipId: c.a, patch: { enabled: false } } as never);
    expect(planAudio(r.ed.state, r.env)).toHaveLength(0);
    expect(clip(r.ed.state, c.a).enabled).toBe(false);
  });
});
