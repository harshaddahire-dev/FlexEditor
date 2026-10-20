import { describe, expect, it } from 'vitest';
import { diffIsEmpty, diffSequences, diffSummary } from '../../src';
import { clipsOn, insertAV, rig, run } from './helpers';

describe('diffSequences', () => {
  it('is empty for identical sequences', () => {
    const r = rig();
    insertAV(r, 0, 0, 10);
    expect(diffIsEmpty(diffSequences(r.ed.state, r.ed.state))).toBe(true);
  });

  it('reads a split as one trimmed piece plus an added piece (per track)', () => {
    const r = rig();
    const c = insertAV(r, 0, 0, 10);
    const before = r.ed.state;
    run(r, { type: 'split', clipId: c.v, at: r.f(100) });
    const d = diffSequences(before, r.ed.state);
    expect(d.added).toHaveLength(2); // video + audio right halves
    expect(d.changed.map((x) => [x.before.trackName, x.what])).toEqual(expect.arrayContaining([['V1', ['trimmed']], ['A1', ['trimmed']]]));
    expect(d.removed).toEqual([]);
    expect(diffSummary(d)).toBe('+2 items · 2 changed');
  });

  it('reports removals, moves and property changes', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 5);
    const b = insertAV(r, 150, 10, 15);
    const before = r.ed.state;
    run(r, { type: 'delete', itemIds: [a.v], linked: true });
    run(r, { type: 'move', clipIds: [b.v], delta: r.f(30), linked: true });
    run(r, { type: 'setClipProps', clipId: b.a, patch: { audio: { gainDb: -6 } }, linked: false });
    const d = diffSequences(before, r.ed.state);
    expect(d.removed.map((x) => x.id).sort()).toEqual([a.a, a.v].sort());
    const moved = d.changed.find((x) => x.after.id === b.v)!;
    expect(moved.what).toEqual(['moved']);
    expect(moved.after.start - moved.before.start).toBe(r.f(30));
    expect(d.changed.find((x) => x.after.id === b.a)!.what).toContain('props');
    expect(clipsOn(r.ed.state, r.ids.V1)).toHaveLength(1);
  });

  it('detects speed changes', () => {
    const r = rig();
    const a = insertAV(r, 0, 0, 10);
    const before = r.ed.state;
    run(r, { type: 'setSpeed', clipId: a.v, speed: { num: 2, den: 1 }, linked: true, ripple: false });
    const d = diffSequences(before, r.ed.state);
    expect(d.changed.every((x) => x.what.includes('retimed'))).toBe(true);
  });
});

describe('transaction groups', () => {
  it('undoGroup and redoGroup act on the run at the top of the stack as one', () => {
    const r = rig();
    const c = insertAV(r, 0, 0, 20); // user edit, ungrouped
    r.ed.apply({ type: 'split', clipId: c.v, at: r.f(100) }, { group: 'g1', origin: 'agent:director' });
    r.ed.apply({ type: 'setClipProps', clipId: c.a, patch: { audio: { gainDb: -3 } }, linked: false }, { group: 'g1', origin: 'agent:audio' });
    expect(r.ed.history.map((t) => t.group)).toEqual([undefined, 'g1', 'g1']);
    expect(r.ed.undoGroup('other')).toBe(0);
    expect(r.ed.undoGroup('g1')).toBe(2);
    expect(clipsOn(r.ed.state, r.ids.V1)).toHaveLength(1);
    expect(r.ed.canUndo).toBe(true); // the user's own insert is still there
    expect(r.ed.redoGroup('g1')).toBe(2);
    expect(clipsOn(r.ed.state, r.ids.V1)).toHaveLength(2);
  });
});
