import { describe, expect, it } from 'vitest';
import { EditError, roundTo, frameTicks, makeTimebase, msToTicks, sampleTicks, tbSecondsToTicks, ticksToFrames, ticksToSamples } from '../../src';
import { rational } from '../../src/time';
import { NTSC, clip, clipsOn, frames, insertAV, problems, rig, run, track } from './helpers';

describe('timebase', () => {
  it.each([
    ['30', rational(30), 48000, 1600, 1],
    ['25', rational(25), 48000, 1920, 1],
    ['24', rational(24), 48000, 2000, 1],
    ['23.976', rational(24000, 1001), 48000, 2002, 1],
    ['29.97', NTSC, 240000, 8008, 5],
    ['59.94', rational(60000, 1001), 240000, 4004, 5],
    ['60', rational(60), 48000, 800, 1],
    ['50', rational(50), 48000, 960, 1],
  ])('%s fps → frames and samples are whole ticks', (_n, fps, rate, frame, sample) => {
    const tb = makeTimebase(fps);
    expect(tb.rate).toBe(rate);
    expect(frameTicks(tb)).toBe(frame);
    expect(sampleTicks(tb)).toBe(sample);
  });

  it('one second is 30000/1001 frames at 29.97 and exactly 48000 samples', () => {
    const tb = makeTimebase(NTSC);
    expect(ticksToSamples(tb.rate, tb)).toBe(48000);
    expect(ticksToFrames(tb.rate * 1001, tb)).toBe(30000);
    expect(tbSecondsToTicks(rational(1001, 1), tb)).toBe(1001 * 240000);
    expect(msToTicks(8, tb)).toBe(1920);
  });
});

describe('rounding', () => {
  it('never produces negative zero (it would not survive a save/load round-trip)', () => {
    for (const mode of ['round', 'floor', 'ceil', 'trunc'] as const) {
      for (const v of [-0.3, -0.49, -1e-9, 0, -0]) expect(Object.is(roundTo(v, 1600, mode), -0), `${mode} ${v}`).toBe(false);
    }
    expect(roundTo(-2400, 1600)).toBe(-3200); // ties away from zero
    expect(roundTo(2400, 1600)).toBe(3200);
  });
});

describe('insert', () => {
  it('places linked A/V clips with deterministic ids and a link group', () => {
    const r = rig();
    insertAV(r, 0);
    const [v] = clipsOn(r.ed.state, r.ids.V1);
    const [a] = clipsOn(r.ed.state, r.ids.A1);
    expect(v).toMatchObject({ start: 0, duration: r.s(10), sourceIn: 0, mediaId: 'av' });
    expect(new Set([v!.id, a!.id]).size).toBe(2);
    expect(a).toMatchObject({ start: 0, duration: r.s(10), sourceIn: 0 });
    expect(v!.linkGroupId).toBeDefined();
    expect(v!.linkGroupId).toBe(a!.linkGroupId);
    expect(problems(r)).toEqual([]);
  });

  it('is deterministic: same ops on the same state give identical results', () => {
    const a = rig();
    const b = rig();
    insertAV(a, 0);
    insertAV(b, 0);
    expect(a.ed.state).toEqual(b.ed.state);
  });

  it('ripples later clips and splits a clip straddling the insertion point', () => {
    const r = rig();
    insertAV(r, 0, 0, 10, 'av'); // 300 frames
    insertAV(r, 150, 20, 22, 'av'); // 60 frames in the middle
    const v = clipsOn(r.ed.state, r.ids.V1);
    expect(v.map((c) => frames(r, c))).toEqual([
      [0, 150, 0], //   first half of the original
      [150, 60, 600], // inserted: source 20 s = frame 600
      [210, 150, 150], // second half pushed right by 60 frames, still showing source frame 150
    ]);
    const a = clipsOn(r.ed.state, r.ids.A1);
    expect(a.map((c) => frames(r, c))).toEqual(v.map((c) => frames(r, c)));
    // each cut half stays linked with its own partner
    expect(v[0]!.linkGroupId).toBe(a[0]!.linkGroupId);
    expect(v[2]!.linkGroupId).toBe(a[2]!.linkGroupId);
    expect(v[0]!.linkGroupId).not.toBe(v[2]!.linkGroupId);
    expect(problems(r)).toEqual([]);
  });

  it('shifts markers at or after the insert point', () => {
    const r = rig();
    run(r, { type: 'addMarker', time: r.f(10), label: 'before' });
    run(r, { type: 'addMarker', time: r.f(100), label: 'after' });
    insertAV(r, 50, 0, 1);
    expect(r.ed.state.markers.map((m) => m.time / r.F)).toEqual([10, 130]);
  });

  it('refuses media that does not fit the track, media past its end, and locked tracks', () => {
    const r = rig();
    expect(() => run(r, { type: 'insert', at: 0, clips: [{ trackId: r.ids.V1, mediaId: 'a', sourceIn: 0, sourceOut: r.s(1) }] })).toThrow(/cannot hold audio-only/);
    expect(() => run(r, { type: 'insert', at: 0, clips: [{ trackId: r.ids.V1, mediaId: 'v', sourceIn: r.s(29), sourceOut: r.s(31) }] })).toThrow(/past the end/);
    run(r, { type: 'setTrackProps', trackId: r.ids.V1, patch: { locked: true } });
    expect(() => run(r, { type: 'insert', at: 0, clips: [{ trackId: r.ids.V1, mediaId: 'v', sourceIn: 0, sourceOut: r.s(1) }] })).toThrow(/locked/);
  });

  it('a failed operation leaves the state untouched', () => {
    const r = rig();
    const { v } = insertAV(r, 0);
    const before = r.ed.state;
    expect(() => run(r, { type: 'split', clipId: v, at: r.f(9999) })).toThrow(EditError);
    expect(r.ed.state).toBe(before);
    expect(r.ed.canUndo).toBe(true);
    expect(r.ed.history).toHaveLength(1);
  });
});

describe('overwrite', () => {
  it('replaces the covered span: trims both neighbours', () => {
    const r = rig();
    insertAV(r, 0, 0, 10); // frames 0..300
    run(r, { type: 'overwrite', at: r.f(100), clips: [{ trackId: r.ids.V1, mediaId: 'v', sourceIn: 0, sourceOut: r.s(2) }] }); // 100..160
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => [c.mediaId, ...frames(r, c)])).toEqual([
      ['av', 0, 100, 0],
      ['v', 100, 60, 0],
      ['av', 160, 140, 160], // tail keeps showing source frame 160
    ]);
    // audio untouched — overwrite only affected the video track
    expect(clipsOn(r.ed.state, r.ids.A1)).toHaveLength(1);
    expect(problems(r)).toEqual([]);
  });

  it('removes fully covered clips', () => {
    const r = rig();
    insertAV(r, 0, 0, 1);
    insertAV(r, 30, 1, 2);
    run(r, { type: 'overwrite', at: 0, clips: [{ trackId: r.ids.V1, mediaId: 'v', sourceIn: 0, sourceOut: r.s(5) }] });
    expect(clipsOn(r.ed.state, r.ids.V1)).toHaveLength(1);
  });
});

describe('split', () => {
  it('cuts a linked pair at one point; both halves continue the same source', () => {
    const r = rig();
    const { v } = insertAV(r, 0, 0, 10);
    run(r, { type: 'split', clipId: v, at: r.f(120) });
    for (const id of [r.ids.V1, r.ids.A1]) {
      const [l, rt] = clipsOn(r.ed.state, id);
      expect(frames(r, l!)).toEqual([0, 120, 0]);
      expect(frames(r, rt!)).toEqual([120, 180, 120]);
    }
    expect(problems(r)).toEqual([]);
  });

  it('rejects a split outside the clip; unlinked split leaves the partner whole', () => {
    const r = rig();
    const { v } = insertAV(r, 0, 0, 10);
    expect(() => run(r, { type: 'split', clipId: v, at: 0 })).toThrow(/not inside/);
    run(r, { type: 'split', clipId: v, at: r.f(60), linked: false });
    expect(clipsOn(r.ed.state, r.ids.V1)).toHaveLength(2);
    expect(clipsOn(r.ed.state, r.ids.A1)).toHaveLength(1);
  });

  it('snaps the cut to the frame grid when video is involved', () => {
    const r = rig();
    const { v } = insertAV(r, 0, 0, 10);
    run(r, { type: 'split', clipId: v, at: r.f(100) + 700 }); // 700 ticks past a frame
    expect(clipsOn(r.ed.state, r.ids.V1)[1]!.start).toBe(r.f(100)); // 700 < half a frame (800) → rounds down
    run(r, { type: 'split', clipId: v, at: r.f(50) + 900, linked: false });
    expect(clipsOn(r.ed.state, r.ids.V1)[1]!.start).toBe(r.f(51)); // 900 > 800 → rounds up
  });

  it('moves a transition that ended at the old out point to the right half', () => {
    const r = rig();
    insertAV(r, 0, 0, 5);
    insertAV(r, 150, 10, 15);
    const [a, b] = clipsOn(r.ed.state, r.ids.V1);
    run(r, { type: 'addTransition', betweenClipIds: [a!.id, b!.id], transitionType: 'dissolve', duration: r.f(10) });
    run(r, { type: 'split', clipId: a!.id, at: r.f(75) });
    const [, right, next] = clipsOn(r.ed.state, r.ids.V1);
    expect(track(r.ed.state, r.ids.V1).transitions.map((t) => t.betweenClipIds)).toEqual([[right!.id, next!.id]]);
  });

  it('carries an exact animation across the cut', () => {
    const r = rig();
    const { v } = insertAV(r, 0, 0, 10);
    run(r, { type: 'addKeyframe', clipId: v, prop: 'opacity', keyframe: { time: 0, value: 0, interpolation: 'linear' } });
    run(r, { type: 'addKeyframe', clipId: v, prop: 'opacity', keyframe: { time: r.f(300) - 0, value: 1, interpolation: 'linear' } });
    run(r, { type: 'split', clipId: v, at: r.f(150) });
    const [l, rt] = clipsOn(r.ed.state, r.ids.V1);
    expect(l!.keyframes.opacity!.map((k) => [k.time / r.F, k.value])).toEqual([[0, 0], [150, 0.5]]);
    expect(rt!.keyframes.opacity!.map((k) => [k.time / r.F, k.value])).toEqual([[0, 0.5], [150, 1]]);
  });
});

describe('trim', () => {
  it('trims the end and start; the partner follows', () => {
    const r = rig();
    const { v } = insertAV(r, 30, 5, 15); // frames 30..330, source 150..450
    run(r, { type: 'trim', clipId: v, edge: 'end', to: r.f(230) });
    run(r, { type: 'trim', clipId: v, edge: 'start', to: r.f(80) });
    for (const id of [r.ids.V1, r.ids.A1]) expect(frames(r, clipsOn(r.ed.state, id)[0]!)).toEqual([80, 150, 200]);
    expect(problems(r)).toEqual([]);
  });

  it('extends into available handle media and stops at the media boundary', () => {
    const r = rig();
    const { v } = insertAV(r, 100, 5, 15);
    run(r, { type: 'trim', clipId: v, edge: 'start', to: r.f(50) }); // 50 frames of head handle
    expect(frames(r, clip(r.ed.state, v))).toEqual([50, 350, 100]);
    expect(() => run(r, { type: 'trim', clipId: v, edge: 'start', to: r.f(-1000) })).toThrow(/before the (beginning|timeline)/);
    expect(() => run(r, { type: 'trim', clipId: v, edge: 'end', to: r.f(50 + 350 + 2000) })).toThrow(/past the end/);
  });

  it('cannot trim through a neighbour or to zero length', () => {
    const r = rig();
    const { v } = insertAV(r, 0, 0, 5);
    insertAV(r, 150, 20, 25);
    expect(() => run(r, { type: 'trim', clipId: v, edge: 'end', to: r.f(160) })).toThrow(/overlaps/);
    expect(() => run(r, { type: 'trim', clipId: v, edge: 'end', to: 0 })).toThrow(/no length/);
  });

  it('unlinked trim makes an L-cut: audio longer than video, still in sync', () => {
    const r = rig();
    const ids = insertAV(r, 0, 0, 10);
    run(r, { type: 'trim', clipId: ids.v, edge: 'end', to: r.f(240), linked: false });
    const vc = clipsOn(r.ed.state, r.ids.V1)[0]!;
    const ac = clipsOn(r.ed.state, r.ids.A1)[0]!;
    expect([vc.duration / r.F, ac.duration / r.F]).toEqual([240, 300]);
    expect(problems(r)).toEqual([]); // trimming never changes the timeline→source mapping
  });

  it('refuses edits on a locked track', () => {
    const r = rig();
    const { v } = insertAV(r, 0);
    run(r, { type: 'setTrackProps', trackId: r.ids.A1, patch: { locked: true } });
    expect(() => run(r, { type: 'trim', clipId: v, edge: 'end', to: r.f(100) })).toThrow(/locked/);
  });
});
