import { describe, expect, it } from 'vitest';
import { audioJoins, isContinuous, msToTicks, trackItems, type Clip } from '../../src';
import { NTSC, clip, clipsOn, insertAV, problems, rig, run, track } from './helpers';

describe('keyframes', () => {
  it('add (sorted, replaces same time), remove, bulk set; refuses times outside the clip', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 2); // 60 frames
    const add = (time: number, value: number) => run(r, { type: 'addKeyframe', clipId: a.v, prop: 'opacity', keyframe: { time, value, interpolation: 'linear' } });
    add(r.f(30), 1);
    add(r.f(0), 0);
    add(r.f(30), 0.8); // replaces
    expect(clip(r.ed.state, a.v).keyframes.opacity!.map((k) => [k.time / r.F, k.value])).toEqual([[0, 0], [30, 0.8]]);
    expect(() => add(r.f(61), 1)).toThrow(/outside clip/);
    expect(() => add(-1, 1)).toThrow(/outside clip/);
    run(r, { type: 'removeKeyframe', clipId: a.v, prop: 'opacity', time: r.f(30) });
    expect(clip(r.ed.state, a.v).keyframes.opacity).toHaveLength(1);
    expect(() => run(r, { type: 'removeKeyframe', clipId: a.v, prop: 'opacity', time: r.f(7) })).toThrow(/No opacity keyframe/);
    run(r, { type: 'setKeyframes', clipId: a.v, prop: 'scale.x', keyframes: [{ time: 0, value: 1, interpolation: 'bezier', bezier: [0.42, 0, 0.58, 1] }, { time: r.f(60), value: 1.2, interpolation: 'linear' }] });
    expect(clip(r.ed.state, a.v).keyframes['scale.x']).toHaveLength(2);
    expect(() => run(r, { type: 'setKeyframes', clipId: a.v, prop: 'scale.x', keyframes: [{ time: 0, value: 1, interpolation: 'linear' }, { time: 0, value: 2, interpolation: 'linear' }] })).toThrow(/Duplicate/);
    run(r, { type: 'setKeyframes', clipId: a.v, prop: 'scale.x', keyframes: [] });
    expect(clip(r.ed.state, a.v).keyframes['scale.x']).toBeUndefined();
    expect(problems(r)).toEqual([]);
  });

  it('trimming a clip keeps every keyframe inside its new bounds', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 10); // 300 frames
    for (const [t, v] of [[0, 0], [100, 1], [200, 0], [300, 1]] as const) run(r, { type: 'addKeyframe', clipId: a.v, prop: 'opacity', keyframe: { time: r.f(t), value: v, interpolation: 'linear' } });
    run(r, { type: 'trim', clipId: a.v, edge: 'start', to: r.f(50) });
    run(r, { type: 'trim', clipId: a.v, edge: 'end', to: r.f(250) });
    const kfs = clip(r.ed.state, a.v).keyframes.opacity!;
    expect(kfs.every((k) => k.time >= 0 && k.time <= r.f(200))).toBe(true);
    expect(kfs[0]).toMatchObject({ time: 0, value: 0.5 }); // value at old frame 50
    expect(problems(r)).toEqual([]);
  });

  it('removing an effect also removes its animated parameters', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 2);
    run(r, { type: 'applyEffect', clipId: a.v, effect: { type: 'blur', params: { amount: 0 } } });
    const fx = clip(r.ed.state, a.v).effects[0]!;
    run(r, { type: 'addKeyframe', clipId: a.v, prop: `effect:${fx.id}.amount`, keyframe: { time: 0, value: 0, interpolation: 'linear' } });
    run(r, { type: 'removeEffect', clipId: a.v, effectId: fx.id });
    expect(Object.keys(clip(r.ed.state, a.v).keyframes)).toEqual([]);
  });
});

describe('effects', () => {
  it('apply, update, toggle, reorder', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 2);
    run(r, { type: 'applyEffect', clipId: a.v, effect: { type: 'exposure', params: { stops: 0.5 } } });
    run(r, { type: 'applyEffect', clipId: a.v, effect: { type: 'blur', params: { radius: 4 } } });
    const [e1, e2] = clip(r.ed.state, a.v).effects;
    run(r, { type: 'setEffect', clipId: a.v, effectId: e1!.id, params: { stops: 1 }, enabled: false });
    run(r, { type: 'reorderEffect', clipId: a.v, effectId: e2!.id, toIndex: 0 });
    const fx = clip(r.ed.state, a.v).effects;
    expect(fx.map((e) => e.type)).toEqual(['blur', 'exposure']);
    expect(fx[1]).toMatchObject({ enabled: false, params: { stops: 1 } });
    expect(() => run(r, { type: 'setEffect', clipId: a.v, effectId: 'nope' })).toThrow(/No effect/);
  });
});

describe('captions', () => {
  it('lives on caption tracks only, frame-aligned, non-overlapping', () => {
    const r = rig();
    run(r, { type: 'addTrack', kind: 'caption' });
    const ct = r.ed.state.tracks.find((t) => t.kind === 'caption')!;
    const words = [{ text: 'hello', start: r.f(10), end: r.f(15) }, { text: 'world', start: r.f(16), end: r.f(24) }];
    run(r, { type: 'addCaption', trackId: ct.id, start: r.f(10), duration: r.f(15), words, styleId: 'bold' });
    expect(trackItems(track(r.ed.state, ct.id))).toHaveLength(1);
    expect(() => run(r, { type: 'addCaption', trackId: ct.id, start: r.f(20), duration: r.f(10), words: [], styleId: 'x' })).toThrow(/overlaps/);
    expect(() => run(r, { type: 'addCaption', trackId: r.ids.V1, start: 0, duration: r.f(10), words: [], styleId: 'x' })).toThrow(/not a caption track/);
    expect(() => run(r, { type: 'insert', at: 0, clips: [{ trackId: ct.id, mediaId: 'v', sourceIn: 0, sourceOut: r.s(1) }] })).toThrow(/caption track/);
    const id = trackItems(track(r.ed.state, ct.id))[0]!.id;
    run(r, { type: 'updateCaption', id, patch: { styleId: 'karaoke', duration: r.f(20) } });
    expect(trackItems(track(r.ed.state, ct.id))[0]).toMatchObject({ styleId: 'karaoke', duration: r.f(20) });
    expect(problems(r)).toEqual([]);
  });

  it('setCaptions replaces the whole track atomically and word times stay exact ticks', () => {
    const r = rig(NTSC);
    run(r, { type: 'addTrack', kind: 'caption' });
    const ct = r.ed.state.tracks.find((t) => t.kind === 'caption')!;
    const exact = 123457; // an arbitrary tick: caption words keep their precise (sub-frame) timing
    run(r, { type: 'setCaptions', trackId: ct.id, items: [{ start: 0, duration: r.F * 30, words: [{ text: 'a', start: exact, end: exact + 5000 }], styleId: 'default' }], createdBy: 'agent:captioner' });
    run(r, { type: 'setCaptions', trackId: ct.id, items: [{ start: 0, duration: r.F * 30, words: [{ text: 'b', start: exact, end: exact + 5000 }], styleId: 'default' }] });
    const items = trackItems(track(r.ed.state, ct.id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'caption', words: [{ text: 'b', start: exact, end: exact + 5000 }] });
  });

  it('removeRange trims captions and drops words in the removed span', () => {
    const r = rig();
    insertAV(r, 0, 0, 5);
    run(r, { type: 'addTrack', kind: 'caption' });
    const ct = r.ed.state.tracks.find((t) => t.kind === 'caption')!;
    run(r, { type: 'addCaption', trackId: ct.id, start: r.f(0), duration: r.f(100), words: [{ text: 'keep', start: r.f(5), end: r.f(10) }, { text: 'gone', start: r.f(40), end: r.f(45) }, { text: 'tail', start: r.f(90), end: r.f(95) }], styleId: 'x' });
    run(r, { type: 'removeRange', start: r.f(30), end: r.f(60) });
    const items = trackItems(track(r.ed.state, ct.id));
    expect(items.map((i) => [i.start / r.F, i.duration / r.F])).toEqual([[0, 30], [30, 40]]);
    expect(items.flatMap((i) => (i.kind === 'caption' ? i.words.map((w) => [w.text, w.start / r.F]) : []))).toEqual([['keep', 5], ['tail', 60]]);
  });
});

describe('tracks, markers, sequence', () => {
  it('add / reorder / rename / lock; removing a non-empty track needs force', () => {
    const r = rig();
    run(r, { type: 'addTrack', kind: 'video', name: 'Titles', index: 0 });
    expect(r.ed.state.tracks[0]).toMatchObject({ name: 'Titles', kind: 'video', crossfadeMs: 0 });
    run(r, { type: 'moveTrack', trackId: r.ed.state.tracks[0]!.id, toIndex: 2 });
    expect(r.ed.state.tracks[2]!.name).toBe('Titles');
    run(r, { type: 'setTrackProps', trackId: r.ids.A1, patch: { name: 'Dialogue', muted: true, height: 80 } });
    expect(track(r.ed.state, r.ids.A1)).toMatchObject({ name: 'Dialogue', muted: true, height: 80 });
    insertAV(r, 0, 0, 2);
    expect(() => run(r, { type: 'removeTrack', trackId: r.ids.V1 })).toThrow(/still holds/);
    run(r, { type: 'removeTrack', trackId: r.ids.V1, force: true });
    expect(r.ed.state.tracks.find((t) => t.id === r.ids.V1)).toBeUndefined();
    expect(clipsOn(r.ed.state, r.ids.A1)).toHaveLength(1);
    expect(clip(r.ed.state, clipsOn(r.ed.state, r.ids.A1)[0]!.id).linkGroupId).toBeUndefined(); // its video partner is gone
    expect(problems(r)).toEqual([]);
  });

  it('markers: add, move, rename, remove; kept sorted', () => {
    const r = rig();
    run(r, { type: 'addMarker', time: r.f(50), label: 'b', note: 'check audio' });
    run(r, { type: 'addMarker', time: r.f(10), label: 'a' });
    expect(r.ed.state.markers.map((m) => m.label)).toEqual(['a', 'b']);
    const id = r.ed.state.markers[0]!.id;
    run(r, { type: 'setMarker', id, patch: { time: r.f(99), label: 'a2' } });
    expect(r.ed.state.markers.map((m) => m.label)).toEqual(['b', 'a2']);
    run(r, { type: 'removeMarker', id });
    expect(r.ed.state.markers).toHaveLength(1);
    expect(() => run(r, { type: 'removeMarker', id })).toThrow(/No marker/);
  });
});

describe('audio joins (derived crossfades shared by preview, export and QA)', () => {
  const tbOf = (r: ReturnType<typeof rig>) => r.ed.state.timebase;

  it('a plain split is continuous: no fade is needed', () => {
    const r = rig();
    const a = insertAV(r, 0, 10, 20);
    run(r, { type: 'split', clipId: a.v, at: r.f(100) });
    const joins = audioJoins(track(r.ed.state, r.ids.A1), tbOf(r), r.env);
    expect(joins.filter((j) => j.kind === 'continuous')).toHaveLength(1);
    const [l, rt] = clipsOn(r.ed.state, r.ids.A1);
    expect(isContinuous(l as Clip, rt as Clip)).toBe(true);
  });

  it('a removed range becomes an 8 ms equal-power centred crossfade when both sides have handles', () => {
    const r = rig();
    insertAV(r, 0, 10, 20);
    run(r, { type: 'removeRange', start: r.f(100), end: r.f(130) });
    const joins = audioJoins(track(r.ed.state, r.ids.A1), tbOf(r), r.env);
    const x = joins.find((j) => j.kind === 'crossfade')!;
    expect(x).toBeDefined();
    expect(x.time).toBe(r.f(100));
    expect(x.duration).toBe(msToTicks(8, tbOf(r)));
    expect(x.duration).toBe(384 * r.S); // 8 ms = 384 samples
  });

  it('falls back to de-click fades when there is no handle to overlap, and at clip ends', () => {
    const r = rig();
    // the first clip ends at the very end of its media (no tail handle), the second starts at the very start of
    // its media (no head handle): nothing to overlap, so each side gets its own de-click fade
    insertAV(r, 0, 58, 60);
    insertAV(r, 60, 0, 2);
    const joins = audioJoins(track(r.ed.state, r.ids.A1), tbOf(r), r.env);
    expect(joins.map((j) => j.kind)).toEqual(['fade-in', 'fade-out', 'fade-in', 'fade-out']);
    expect(joins.every((j) => j.duration === msToTicks(8, tbOf(r)))).toBe(true);
  });

  it('crossfadeMs = 0 disables derived fades (and QA flags the hard edges)', () => {
    const r = rig();
    run(r, { type: 'setTrackProps', trackId: r.ids.A1, patch: { crossfadeMs: 0 } });
    insertAV(r, 0, 10, 12);
    expect(audioJoins(track(r.ed.state, r.ids.A1), tbOf(r), r.env).every((j) => j.duration === 0)).toBe(true);
    expect(problems(r).some((i) => i.code === 'audio_click')).toBe(true);
  });

  it('a stored audio transition overrides the derived crossfade', () => {
    const r = rig();
    const a = insertAV(r, 0, 10, 15);
    insertAV(r, 150, 30, 35);
    run(r, { type: 'addTransition', betweenClipIds: [a.a, clipsOn(r.ed.state, r.ids.A1)[1]!.id], transitionType: 'crossfade', duration: r.f(15) });
    const j = audioJoins(track(r.ed.state, r.ids.A1), tbOf(r), r.env).find((x) => x.kind === 'transition')!;
    expect(j.duration).toBe(r.f(15));
  });
});

describe('validateSequence editorial warnings', () => {
  it('flags flash frames, gaps and desync', () => {
    const r = rig();
    insertAV(r, 0, 0, 5);
    run(r, { type: 'overwrite', at: r.f(60), clips: [{ trackId: r.ids.V1, mediaId: 'v', sourceIn: 0, sourceOut: r.f(2) }] }); // 2-frame clip
    run(r, { type: 'move', clipIds: [clipsOn(r.ed.state, r.ids.V1).at(-1)!.id], delta: r.f(100), mode: 'strict' });
    const codes = problems(r, undefined, { gaps: true }).map((i) => i.code);
    expect(codes).toContain('flash_frame');
    expect(codes).toContain('gap');
    // desync after an unlinked slip is reported as a warning, not an error
    const b = rig();
    const x = insertAV(b, 0, 10, 15);
    run(b, { type: 'slip', clipId: x.v, delta: b.f(3), linked: false });
    const issues = problems(b);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.find((i) => i.code === 'desync')).toMatchObject({ severity: 'warn' });
    expect(issues.find((i) => i.code === 'desync')!.message).toMatch(/100\.00 ms/);
  });
});
