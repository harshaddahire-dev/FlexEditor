import { describe, expect, it } from 'vitest';
import { allClips, syncDelta } from '../../src';
import { NTSC, clip, clipsOn, frames, insertAV, problems, rig, run, track } from './helpers';

describe('rippleTrim', () => {
  it('end: later clips follow by the length change, on the partner track too', () => {
    const r = rig();
    const first = insertAV(r, 0, 0, 5); // 0..150
    insertAV(r, 150, 10, 15); // 150..300
    run(r, { type: 'rippleTrim', clipId: first.v, edge: 'end', to: r.f(100) });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => frames(r, c))).toEqual([[0, 100, 0], [100, 150, 300]]);
    expect(clipsOn(r.ed.state, r.ids.A1).map((c) => frames(r, c))).toEqual([[0, 100, 0], [100, 150, 300]]);
    expect(problems(r)).toEqual([]);
  });

  it('end: extending pushes later clips right', () => {
    const r = rig();
    const first = insertAV(r, 0, 0, 5);
    insertAV(r, 150, 10, 15);
    run(r, { type: 'rippleTrim', clipId: first.v, edge: 'end', to: r.f(180) });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => frames(r, c))).toEqual([[0, 180, 0], [180, 150, 300]]);
  });

  it('start: the clip keeps its position, the head is removed and the gap closes', () => {
    const r = rig();
    insertAV(r, 0, 0, 5);
    const second = insertAV(r, 150, 10, 15);
    run(r, { type: 'rippleTrim', clipId: second.v, edge: 'start', to: r.f(170) }); // trim 20 frames off the head
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => frames(r, c))).toEqual([[0, 150, 0], [150, 130, 320]]);
    expect(problems(r)).toEqual([]);
  });

  it('can ripple unrelated tracks (rippleTracks: all)', () => {
    const r = rig();
    const first = insertAV(r, 0, 0, 5);
    insertAV(r, 150, 10, 15);
    run(r, { type: 'overwrite', at: r.f(200), clips: [{ trackId: r.ids.A2, mediaId: 'a', sourceIn: 0, sourceOut: r.s(2) }] });
    run(r, { type: 'rippleTrim', clipId: first.v, edge: 'end', to: r.f(100), rippleTracks: 'all' });
    expect(clipsOn(r.ed.state, r.ids.A2)[0]!.start).toBe(r.f(150));
  });
});

describe('rollTrim', () => {
  it('moves the cut between two clips; total length is unchanged', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 5);
    const b = insertAV(r, 150, 10, 15);
    run(r, { type: 'rollTrim', leftClipId: a.v, rightClipId: b.v, to: r.f(120) });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => frames(r, c))).toEqual([[0, 120, 0], [120, 180, 270]]);
    expect(clipsOn(r.ed.state, r.ids.A1).map((c) => frames(r, c))).toEqual([[0, 120, 0], [120, 180, 270]]);
    expect(problems(r)).toEqual([]);
  });

  it('needs touching clips and available handles', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 5);
    const b = insertAV(r, 200, 10, 15);
    expect(() => run(r, { type: 'rollTrim', leftClipId: a.v, rightClipId: b.v, to: r.f(100) })).toThrow(/touch/);
    const c = insertAV(r, 350, 20, 25); // not touching either
    void c;
    run(r, { type: 'move', clipIds: [b.v], delta: r.f(-50) });
    expect(() => run(r, { type: 'rollTrim', leftClipId: a.v, rightClipId: b.v, to: r.f(150 + 5000) })).toThrow();
  });
});

describe('slip & slide', () => {
  it('slip changes what plays without moving the clip; partner slips too', () => {
    const r = rig();
    const a = insertAV(r, 30, 5, 10);
    run(r, { type: 'slip', clipId: a.v, delta: r.f(15) });
    expect(frames(r, clipsOn(r.ed.state, r.ids.V1)[0]!)).toEqual([30, 150, 165]);
    expect(frames(r, clipsOn(r.ed.state, r.ids.A1)[0]!)).toEqual([30, 150, 165]);
    expect(() => run(r, { type: 'slip', clipId: a.v, delta: r.f(-9999) })).toThrow(/before the beginning/);
  });

  it('slide moves a clip between its neighbours, which absorb the change', () => {
    const r = rig();
    insertAV(r, 0, 0, 3); // 0..90
    const mid = insertAV(r, 90, 10, 13); // 90..180
    insertAV(r, 180, 20, 23); // 180..270
    run(r, { type: 'slide', clipId: mid.v, delta: r.f(20) });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => frames(r, c))).toEqual([[0, 110, 0], [110, 90, 300], [200, 70, 620]]);
    expect(problems(r)).toEqual([]);
  });

  it('slide needs a neighbour on each side', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 3);
    expect(() => run(r, { type: 'slide', clipId: a.v, delta: r.f(5) })).toThrow(/clip on each side/);
  });
});

describe('move / delete / rippleDelete', () => {
  it('moves linked clips together; strict mode refuses overlap, overwrite carves', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 2); // 0..60
    insertAV(r, 60, 5, 7); // 60..120
    run(r, { type: 'move', clipIds: [a.v], delta: r.f(300) });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => c.start / r.F)).toEqual([60, 300]);
    expect(clipsOn(r.ed.state, r.ids.A1).map((c) => c.start / r.F)).toEqual([60, 300]);
    expect(() => run(r, { type: 'move', clipIds: [a.v], to: r.f(100) })).toThrow(/overlaps/);
    run(r, { type: 'move', clipIds: [a.v], to: r.f(90), mode: 'overwrite' });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => frames(r, c))).toEqual([[60, 30, 150], [90, 60, 0]]);
    expect(problems(r)).toEqual([]);
  });

  it('moves onto another track of the same kind, not a different kind', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 2);
    run(r, { type: 'move', clipIds: [a.v], delta: 0, toTrackId: r.ids.V2, linked: false });
    expect(clipsOn(r.ed.state, r.ids.V2)).toHaveLength(1);
    expect(() => run(r, { type: 'move', clipIds: [a.v], delta: 0, toTrackId: r.ids.A2, linked: false })).toThrow(/Cannot move a video clip onto audio/);
  });

  it('delete leaves a gap; link partner goes too unless unlinked', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 2);
    insertAV(r, 60, 5, 7);
    run(r, { type: 'delete', itemIds: [a.v] });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => c.start / r.F)).toEqual([60]);
    expect(clipsOn(r.ed.state, r.ids.A1).map((c) => c.start / r.F)).toEqual([60]);
  });

  it('rippleDelete closes the gap on every involved track', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 2);
    insertAV(r, 60, 5, 7);
    insertAV(r, 120, 9, 11);
    run(r, { type: 'rippleDelete', clipIds: [a.v] });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => c.start / r.F)).toEqual([0, 60]);
    expect(clipsOn(r.ed.state, r.ids.A1).map((c) => c.start / r.F)).toEqual([0, 60]);
    expect(problems(r)).toEqual([]);
  });

  it('rippleDelete of several clips shifts by the cumulative gap', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 1);
    insertAV(r, 30, 5, 6);
    const c = insertAV(r, 60, 9, 10);
    insertAV(r, 90, 12, 13);
    run(r, { type: 'rippleDelete', clipIds: [a.v, c.v] });
    expect(clipsOn(r.ed.state, r.ids.V1).map((x) => x.start / r.F)).toEqual([0, 30]);
  });
});

describe('removeRange (silence / filler removal)', () => {
  it('cuts the same span from every track and closes the gap, keeping A/V in sync', () => {
    const r = rig();
    insertAV(r, 0, 0, 10); // 0..300
    run(r, { type: 'removeRange', start: r.f(100), end: r.f(130) });
    for (const id of [r.ids.V1, r.ids.A1]) {
      expect(clipsOn(r.ed.state, id).map((c) => frames(r, c))).toEqual([[0, 100, 0], [100, 170, 130]]);
    }
    const [l, rt] = clipsOn(r.ed.state, r.ids.V1);
    expect(l!.linkGroupId).not.toBe(rt!.linkGroupId);
    expect(clipsOn(r.ed.state, r.ids.A1)[0]!.linkGroupId).toBe(l!.linkGroupId);
    expect(problems(r)).toEqual([]);
  });

  it('snaps inward so nothing outside the requested range is removed', () => {
    const r = rig();
    insertAV(r, 0, 0, 10);
    // 100.4 frames … 129.6 frames → frames 101 … 129
    run(r, { type: 'removeRange', start: r.f(100) + 640, end: r.f(130) - 640 });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => frames(r, c))).toEqual([[0, 101, 0], [101, 171, 129]]);
    // 'outward' covers the whole request
    const r2 = rig();
    insertAV(r2, 0, 0, 10);
    run(r2, { type: 'removeRange', start: r2.f(100) + 640, end: r2.f(130) - 640, snap: 'outward' });
    expect(clipsOn(r2.ed.state, r2.ids.V1).map((c) => frames(r2, c))).toEqual([[0, 100, 0], [100, 170, 130]]);
  });

  it('removes several ranges in sequence (back to front keeps positions valid)', () => {
    const r = rig();
    insertAV(r, 0, 0, 10);
    r.ed.begin('cut silences', 'agent:cutter');
    for (const [s, e] of [[200, 220], [100, 110], [40, 50]]) r.ed.apply({ type: 'removeRange', start: r.f(s!), end: r.f(e!) });
    const tx = r.ed.commit('Removed 3 silences');
    expect(tx!.ops).toHaveLength(3);
    expect(clipsOn(r.ed.state, r.ids.V1).reduce((n, c) => n + c.duration, 0) / r.F).toBe(300 - 40);
    expect(problems(r)).toEqual([]);
    r.ed.undo();
    expect(clipsOn(r.ed.state, r.ids.V1)).toHaveLength(1);
  });

  it('non-rippling lift leaves a gap; locked tracks are skipped by default and refused when named', () => {
    const r = rig();
    insertAV(r, 0, 0, 10);
    run(r, { type: 'setTrackProps', trackId: r.ids.A1, patch: { locked: true } });
    run(r, { type: 'removeRange', start: r.f(100), end: r.f(130), ripple: false });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => frames(r, c))).toEqual([[0, 100, 0], [130, 170, 130]]);
    expect(clipsOn(r.ed.state, r.ids.A1)).toHaveLength(1); // locked → untouched
    expect(() => run(r, { type: 'removeRange', start: r.f(10), end: r.f(20), trackIds: [r.ids.A1] })).toThrow(/locked/);
  });

  it('rejects empty or collapsing ranges and removes markers inside the range', () => {
    const r = rig();
    insertAV(r, 0, 0, 10);
    expect(() => run(r, { type: 'removeRange', start: r.f(10), end: r.f(10) })).toThrow(/end must be after/);
    expect(() => run(r, { type: 'removeRange', start: r.f(10) + 100, end: r.f(11) - 100 })).toThrow(/collapses/);
    run(r, { type: 'addMarker', time: r.f(105), label: 'in' });
    run(r, { type: 'addMarker', time: r.f(200), label: 'after' });
    run(r, { type: 'removeRange', start: r.f(100), end: r.f(130) });
    expect(r.ed.state.markers.map((m) => [m.label, m.time / r.F])).toEqual([['after', 170]]);
  });
});

describe('setSpeed', () => {
  it('2× halves the duration and scales keyframes; partner follows', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 10); // 300 frames
    run(r, { type: 'addKeyframe', clipId: a.v, prop: 'opacity', keyframe: { time: r.f(150), value: 1, interpolation: 'linear' } });
    run(r, { type: 'setSpeed', clipId: a.v, speed: { num: 2, den: 1 } });
    const v = clipsOn(r.ed.state, r.ids.V1)[0]!;
    expect(v.duration / r.F).toBe(150);
    expect(v.speed).toEqual({ num: 2, den: 1 });
    expect(v.keyframes.opacity![0]!.time / r.F).toBe(75);
    expect(clipsOn(r.ed.state, r.ids.A1)[0]!.duration / r.F).toBe(150);
    expect(problems(r)).toEqual([]);
  });

  it('slow motion needs the media to cover the stretch only if it extends the source', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 10);
    run(r, { type: 'setSpeed', clipId: a.v, speed: { num: 1, den: 2 } });
    expect(clipsOn(r.ed.state, r.ids.V1)[0]!.duration / r.F).toBe(600);
  });

  it('ripple option shifts the following clips', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 10);
    insertAV(r, 300, 20, 22);
    run(r, { type: 'setSpeed', clipId: a.v, speed: { num: 2, den: 1 }, ripple: true });
    expect(clipsOn(r.ed.state, r.ids.V1).map((c) => c.start / r.F)).toEqual([0, 150]);
    // without ripple growth would collide
    const r2 = rig();
    const b = insertAV(r2, 0, 0, 10);
    insertAV(r2, 300, 20, 22);
    expect(() => run(r2, { type: 'setSpeed', clipId: b.v, speed: { num: 1, den: 2 } })).toThrow(/overlaps/);
  });
});

describe('transitions', () => {
  it('needs touching clips and enough handle media', () => {
    const r = rig();
    const a = insertAV(r, 0, 10, 15);
    const b = insertAV(r, 150, 20, 25);
    run(r, { type: 'addTransition', betweenClipIds: [a.v, b.v], transitionType: 'dissolve', duration: r.f(30) });
    expect(track(r.ed.state, r.ids.V1).transitions).toHaveLength(1);
    expect(problems(r)).toEqual([]);
    // media 'av' starting at 0 has no head handle → centred transition impossible
    const r2 = rig();
    const c = insertAV(r2, 0, 0, 5);
    const d = insertAV(r2, 150, 0, 5);
    expect(() => run(r2, { type: 'addTransition', betweenClipIds: [c.v, d.v], transitionType: 'dissolve', duration: r2.f(30) })).toThrow(/Not enough media handle/);
    // …but 'end' alignment only needs the outgoing... head of the incoming; 'start' needs the tail of the outgoing
    run(r2, { type: 'addTransition', betweenClipIds: [c.v, d.v], transitionType: 'dissolve', duration: r2.f(30), alignment: 'start' });
  });

  it('is clamped when a trim removes the handle it relied on', () => {
    const r = rig();
    const a = insertAV(r, 0, 10, 15);
    const b = insertAV(r, 150, 20, 25);
    run(r, { type: 'addTransition', betweenClipIds: [a.v, b.v], transitionType: 'dissolve', duration: r.f(60) });
    // slip b's content back until only 30 frames of head handle remain: a 60-frame centred transition still fits
    run(r, { type: 'slip', clipId: b.v, delta: r.f(-570) });
    expect(track(r.ed.state, r.ids.V1).transitions[0]!.duration).toBe(r.f(60));
    // one more slip leaves 1 frame of handle → the transition shrinks to 2 × 1 frame
    run(r, { type: 'slip', clipId: b.v, delta: r.f(-29) });
    expect(track(r.ed.state, r.ids.V1).transitions[0]!.duration).toBe(r.f(2));
  });

  it('disappears when the clips stop touching', () => {
    const r = rig();
    const a = insertAV(r, 0, 10, 15);
    const b = insertAV(r, 150, 20, 25);
    run(r, { type: 'addTransition', betweenClipIds: [a.v, b.v], transitionType: 'dissolve', duration: r.f(20) });
    run(r, { type: 'move', clipIds: [b.v], delta: r.f(10) });
    expect(track(r.ed.state, r.ids.V1).transitions).toHaveLength(0);
  });

  it('set / remove', () => {
    const r = rig();
    const a = insertAV(r, 0, 10, 15);
    const b = insertAV(r, 150, 20, 25);
    run(r, { type: 'addTransition', betweenClipIds: [a.v, b.v], transitionType: 'dissolve', duration: r.f(20) });
    const id = track(r.ed.state, r.ids.V1).transitions[0]!.id;
    run(r, { type: 'setTransition', id, patch: { duration: r.f(40), transitionType: 'wipe', params: { angle: 90 } } });
    expect(track(r.ed.state, r.ids.V1).transitions[0]).toMatchObject({ type: 'wipe', duration: r.f(40), params: { angle: 90 } });
    run(r, { type: 'removeTransition', id });
    expect(track(r.ed.state, r.ids.V1).transitions).toHaveLength(0);
  });
});

describe('29.97 fps: linked A/V never drifts', () => {
  it('stays exactly in sync through 300 chained moves (every audio rounding residual absorbed)', () => {
    const r = rig(NTSC);
    expect(r.S).toBe(5);
    expect(r.F).toBe(8008); // not a multiple of 5: audio can never sit exactly on a frame boundary
    const a = insertAV(r, 0, 0, 20);
    let pos = 0;
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 300; i++) {
      const step = Math.round((rnd() - 0.5) * 24);
      const target = Math.max(0, pos + step);
      run(r, { type: 'move', clipIds: [a.v], delta: (target - pos) * r.F });
      pos = target;
    }
    expect(problems(r)).toEqual([]);
    const v = clip(r.ed.state, a.v);
    const au = clip(r.ed.state, a.a);
    expect(v.start).toBe(pos * r.F);
    expect(syncDelta(v, au)).toBe(0); // exact — no drift after 300 moves
    expect(Math.abs(au.start - v.start)).toBeLessThan(r.S);
  });

  it('a linked audio clip follows the video cut exactly — no re-rounding to samples', () => {
    const r = rig(NTSC);
    const a = insertAV(r, 0, 0, 20);
    run(r, { type: 'split', clipId: a.v, at: 7 * r.F });
    const [v1, v2] = clipsOn(r.ed.state, r.ids.V1);
    const [a1, a2] = clipsOn(r.ed.state, r.ids.A1);
    expect(v2!.start).toBe(7 * r.F);
    expect(a2!.start).toBe(v2!.start); // 56056 ticks: a frame boundary that is 0.4 of a sample off the sample grid
    expect(a2!.start % r.S).not.toBe(0);
    expect(syncDelta(v1!, a1!)).toBe(0);
    expect(syncDelta(v2!, a2!)).toBe(0);
    expect(problems(r)).toEqual([]);
  });

  it('audio-only edits stay on whole samples', () => {
    const r = rig(NTSC);
    r.ed.apply({ type: 'insert', at: 0, clips: [{ trackId: r.ids.A2, mediaId: 'a', sourceIn: 0, sourceOut: r.s(10) }] });
    const a = clipsOn(r.ed.state, r.ids.A2)[0]!;
    run(r, { type: 'split', clipId: a.id, at: 12345 }); // not a sample multiple
    const [, right] = clipsOn(r.ed.state, r.ids.A2);
    expect(right!.start).toBe(12345); // 12345 = 2469 × 5 — exactly on a sample here
    run(r, { type: 'split', clipId: right!.id, at: 20000 + 2 });
    expect(clipsOn(r.ed.state, r.ids.A2)[2]!.start % r.S).toBe(0); // 20002 snaps to the 5-tick sample grid
  });

  it('removeRange keeps exact sync (the silence-removal path)', () => {
    const r = rig(NTSC);
    insertAV(r, 0, 0, 30);
    for (const [s, e] of [[400, 440], [200, 233], [50, 61]]) run(r, { type: 'removeRange', start: s! * r.F, end: e! * r.F });
    expect(problems(r)).toEqual([]);
    expect(allClips(r.ed.state).filter((c) => c.trackId === r.ids.A1).length).toBe(4);
  });
});

describe('accept / link / props', () => {
  it('agent clips start unaccepted and are accepted explicitly', () => {
    const r = rig();
    r.ed.apply({ type: 'insert', at: 0, clips: [{ trackId: r.ids.V1, mediaId: 'v', sourceIn: 0, sourceOut: r.s(2), createdBy: 'agent:cutter' }] }, { origin: 'agent:cutter' });
    const [c] = clipsOn(r.ed.state, r.ids.V1);
    expect(c).toMatchObject({ createdBy: 'agent:cutter', accepted: false });
    run(r, { type: 'accept', itemIds: [c!.id] });
    expect(clip(r.ed.state, c!.id).accepted).toBe(true);
  });

  it('link / unlink', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 2);
    run(r, { type: 'unlink', clipIds: [a.v] });
    expect(clip(r.ed.state, a.v).linkGroupId).toBeUndefined();
    expect(clip(r.ed.state, a.a).linkGroupId).toBeUndefined(); // a lone member is tidied away
    run(r, { type: 'link', clipIds: [a.v, a.a] });
    expect(clip(r.ed.state, a.v).linkGroupId).toBe(clip(r.ed.state, a.a).linkGroupId);
  });

  it('setClipProps validates fades and merges transforms', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 2); // 60 frames
    run(r, { type: 'setClipProps', clipId: a.v, patch: { transform: { scale: { x: 1.2, y: 1.2 }, opacity: 0.5, position: { x: 10 } } } });
    expect(clip(r.ed.state, a.v).transform).toMatchObject({ scale: { x: 1.2, y: 1.2 }, opacity: 0.5, position: { x: 10, y: 0 } });
    run(r, { type: 'setClipProps', clipId: a.a, patch: { audio: { gainDb: -6, fadeIn: r.f(10) } } });
    expect(clip(r.ed.state, a.a).audio).toMatchObject({ gainDb: -6, fadeIn: r.f(10), fadeOut: 0 });
    expect(() => run(r, { type: 'setClipProps', clipId: a.a, patch: { audio: { fadeOut: r.f(100) } } })).toThrow(/longer than the clip/);
  });
});
