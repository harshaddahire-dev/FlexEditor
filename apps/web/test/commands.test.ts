import { describe, expect, it } from 'vitest';
import { Editor, createSequence, trackItems, type Media, type MediaRef, type Sequence, mediaRef, rational, type Clip } from '@cutroom/core';
import { CommandError, addMarkerAt, deleteItems, editPoints, expandLinked, moveSelection, placeMedia, rippleTrimToPlayhead, selectForward, splitAtPlayhead, splitClipAt } from '../src/timeline/commands';

const R = 48000;
const mk = (id: string, type: Media['type'], seconds: number, audio = true): Media =>
  ({ id, name: `${id}.mp4`, type, duration: rational(seconds), audio: audio ? { codec: 'aac', sampleRate: 48000, channels: 2, startTime: rational(0) } : undefined, missing: false }) as unknown as Media;
const lib: Record<string, Media> = { clip: mk('clip', 'video', 20), silent: mk('silent', 'video', 10, false), song: mk('song', 'audio', 30), pic: mk('pic', 'image', 0, false) };

function setup() {
  const seq = createSequence({ width: 1920, height: 1080, fps: rational(30) });
  const env = { getMedia: (id: string): MediaRef | undefined => (lib[id] ? mediaRef(lib[id]!, seq.timebase) : undefined) };
  const ed = new Editor(seq, env);
  const run = (ops: ReturnType<typeof placeMedia>) => ops.forEach((o) => ed.apply(o));
  const on = (name: string) => trackItems(ed.state.tracks.find((t) => t.name === name)!) as Clip[];
  return { ed, run, on };
}

describe('placeMedia', () => {
  it('video with audio becomes a linked V1 + A1 pair of the full media length', () => {
    const { ed, run, on } = setup();
    run(placeMedia(ed.state, [lib.clip!], 0, 'insert'));
    expect(on('V1')).toHaveLength(1);
    expect(on('A1')).toHaveLength(1);
    expect(on('V1')[0]).toMatchObject({ start: 0, duration: 20 * R, name: 'clip.mp4' });
    expect(on('V1')[0]!.linkGroupId).toBe(on('A1')[0]!.linkGroupId);
  });
  it('silent video → video only; audio → audio only; stills get five seconds', () => {
    const { ed, run, on } = setup();
    run(placeMedia(ed.state, [lib.silent!, lib.pic!], 0, 'insert'));
    expect(on('V1').map((c) => [c.mediaId, c.start / R, c.duration / R])).toEqual([['silent', 0, 10], ['pic', 10, 5]]);
    expect(on('A1')).toHaveLength(0);
    run(placeMedia(ed.state, [lib.song!], 0, 'overwrite'));
    expect(on('A1')).toHaveLength(1);
    expect(on('V1')).toHaveLength(2);
  });
  it('several items are laid end to end from the insertion point', () => {
    const { ed, run, on } = setup();
    run(placeMedia(ed.state, [lib.clip!, lib.clip!, lib.clip!], 30 * 4 * (R / 30), 'insert'));
    expect(on('V1').map((c) => c.start / R)).toEqual([4, 24, 44]);
  });
  it('honours the target track and skips locked tracks', () => {
    const { ed, run, on } = setup();
    run(placeMedia(ed.state, [lib.silent!], 0, 'insert', 't2'));
    expect(on('V2')).toHaveLength(1);
    ed.apply({ type: 'setTrackProps', trackId: 't1', patch: { locked: true } });
    run(placeMedia(ed.state, [lib.silent!], 20 * R, 'overwrite'));
    expect(on('V2')).toHaveLength(2); // V1 locked → first free video track
    ed.apply({ type: 'setTrackProps', trackId: 't2', patch: { locked: true } });
    expect(() => placeMedia(ed.state, [lib.silent!], 0, 'insert')).toThrow(/no unlocked video track/);
  });
  it('refuses missing media', () => {
    const { ed } = setup();
    expect(() => placeMedia(ed.state, [{ ...lib.clip!, missing: true }], 0, 'insert')).toThrow(CommandError);
  });
});

describe('editing commands apply cleanly to a real sequence', () => {
  const loaded = () => {
    const t = setup();
    t.run(placeMedia(t.ed.state, [lib.clip!], 0, 'insert'));
    t.run(placeMedia(t.ed.state, [lib.song!], 0, 'overwrite', 't4')); // music on A2
    return t;
  };

  it('splitAtPlayhead cuts every track once per link group', () => {
    const { ed, run, on } = loaded();
    run(splitAtPlayhead(ed.state, 5 * R, new Set()));
    expect(on('V1')).toHaveLength(2);
    expect(on('A1')).toHaveLength(2);
    expect(on('A2')).toHaveLength(2); // the unlinked music is cut too
    expect(on('V1')[1]!.start).toBe(5 * R);
  });
  it('a linked partner on a locked track is protected: only the unlocked clip is cut', () => {
    const { ed, run, on } = loaded();
    ed.apply({ type: 'setTrackProps', trackId: 't1', patch: { locked: true } });
    run(splitAtPlayhead(ed.state, 5 * R, new Set()));
    expect(on('V1')).toHaveLength(1); // locked
    expect(on('A1')).toHaveLength(2); // its unlocked partner was cut
    expect(on('A2')).toHaveLength(2);
    expect(on('V1')[0]!.linkGroupId).toBe(on('A1')[0]!.linkGroupId); // still one in-sync group
  });
  it('with a selection only that is cut; errors say why', () => {
    const { ed, run, on } = loaded();
    const music = on('A2')[0]!.id;
    run(splitAtPlayhead(ed.state, 5 * R, new Set([music])));
    expect(on('A2')).toHaveLength(2);
    expect(on('V1')).toHaveLength(1);
    expect(() => splitAtPlayhead(ed.state, 5 * R, new Set(['nope']))).toThrow(/selection is not under/);
    expect(() => splitAtPlayhead(ed.state, 500 * R, new Set())).toThrow(/no clip under the playhead/);
  });
  it('splitClipAt validates the click position', () => {
    const { ed, on } = loaded();
    expect(() => splitClipAt(ed.state, on('V1')[0]!.id, 0)).toThrow(/inside the clip/);
    expect(splitClipAt(ed.state, on('V1')[0]!.id, 3 * R)).toHaveLength(1);
  });
  it('deleteItems lifts or ripples; expandLinked finds the partner', () => {
    const { ed, run, on } = loaded();
    const v = on('V1')[0]!;
    expect(expandLinked(ed.state, [v.id]).sort()).toEqual([v.id, on('A1')[0]!.id].sort());
    run(deleteItems(ed.state, expandLinked(ed.state, [v.id]), false));
    expect(on('V1')).toHaveLength(0);
    expect(on('A1')).toHaveLength(0);
    expect(() => deleteItems(ed.state, [], false)).toThrow(/Nothing is selected/);
  });
  it('rippleTrimToPlayhead (Q/W) closes the gap', () => {
    const { ed, run, on } = loaded();
    run(splitAtPlayhead(ed.state, 5 * R, new Set()));
    const second = on('V1')[1]!;
    run(rippleTrimToPlayhead(ed.state, 8 * R, 'start', new Set([second.id])));
    expect(on('V1')[1]).toMatchObject({ start: 5 * R, duration: 12 * R, sourceIn: 8 * R });
    run(rippleTrimToPlayhead(ed.state, 2 * R, 'end', new Set()));
    expect(on('V1')[0]!.duration).toBe(2 * R);
  });
  it('moveSelection builds a strict or overwriting move', () => {
    const { ed, run, on } = loaded();
    const v = on('V1')[0]!;
    run(moveSelection(ed.state, [v.id, on('A1')[0]!.id], 100 * R));
    expect(on('V1')[0]!.start).toBe(100 * R);
    expect(moveSelection(ed.state, [v.id], 0, { overwrite: true })[0]).toMatchObject({ mode: 'overwrite' });
    expect(() => moveSelection(ed.state, ['x'], 0)).toThrow(CommandError);
  });
  it('selectForward and editPoints', () => {
    const { ed, run, on } = loaded();
    run(splitAtPlayhead(ed.state, 5 * R, new Set()));
    const fwd = selectForward(ed.state, 't1', 6 * R, false);
    expect(fwd).toEqual([on('V1')[1]!.id]);
    expect(selectForward(ed.state, 't1', 6 * R, true)).toHaveLength(3); // second halves of V1, A1 and the music
    const pts = editPoints(ed.state);
    expect(pts).toEqual([...pts].sort((a, b) => a - b));
    expect(pts).toEqual(expect.arrayContaining([0, 5 * R, 20 * R, 30 * R]));
  });
  it('addMarkerAt', () => {
    const { ed, run } = loaded();
    run(addMarkerAt(7 * R, 'Beat'));
    expect(ed.state.markers).toMatchObject([{ time: 7 * R, label: 'Beat' }]);
  });
});

export type { Sequence };
