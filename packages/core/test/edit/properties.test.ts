import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { type Op, type ParsedOp, Editor, EditError, applyOp, applyPatches, hasErrors, isEditError, validateSequence } from '../../src';
import { NTSC, rig, type Rig } from './helpers';
import { mulberry32, randomOp } from './random-ops';
import { rational } from '../../src/time';

interface RunStats {
  accepted: number;
  rejected: number;
  byType: Map<string, number>;
  ops: Op[];
}

/**
 * Drive a random program against an Editor and check, after EVERY operation:
 *  - a rejected op leaves the state referentially unchanged,
 *  - an accepted op leaves a structurally valid sequence (no validator errors; no desync unless we broke it on purpose),
 *  - patches reproduce the new state, inverse restores the previous state exactly.
 */
function runProgram(r: Rig, seed: number, steps: number): RunStats {
  const rng = mulberry32(seed);
  const stats: RunStats = { accepted: 0, rejected: 0, byType: new Map(), ops: [] };
  let allowDesync = false;
  for (let i = 0; i < steps; i++) {
    const before = r.ed.state;
    const { op, desyncs } = randomOp(rng, r, before);
    let result: ReturnType<typeof applyOp> | undefined;
    try {
      result = applyOp(before, op, r.env);
    } catch (e) {
      if (!isEditError(e)) throw new Error(`seed ${seed} step ${i}: non-EditError from ${JSON.stringify(op)}: ${(e as Error).stack}`);
      expect(r.ed.state, `seed ${seed} step ${i}: state changed by rejected ${op.type}`).toBe(before);
      stats.rejected++;
      continue;
    }
    // commit through the editor so history is exercised as well
    r.ed.apply(op);
    expect(r.ed.state).toEqual(result.state);
    stats.accepted++;
    stats.ops.push(op);
    stats.byType.set(op.type, (stats.byType.get(op.type) ?? 0) + 1);
    allowDesync ||= desyncs;

    const issues = validateSequence(result.state, r.env).filter((x) => x.severity === 'error' || (x.code === 'desync' && !allowDesync));
    if (issues.length) throw new Error(`seed ${seed} step ${i} after ${JSON.stringify(op)}:\n${issues.map((x) => `  ${x.code}: ${x.message}`).join('\n')}`);

    expect(applyPatches(before, result.patches), `seed ${seed} step ${i}: patches`).toEqual(result.state);
    expect(applyPatches(result.state, result.inverse), `seed ${seed} step ${i}: inverse of ${op.type}`).toEqual(before);
  }
  return stats;
}

/** `PROP_RUNS=400 pnpm test` for a heavy soak; the default keeps CI fast. */
const RUNS = Number(process.env.PROP_RUNS ?? 40);

describe.each([
  ['30 fps', rational(30)],
  ['29.97 fps', NTSC],
  ['25 fps', rational(25)],
  ['59.94 fps', rational(60000, 1001)],
])('edit engine properties @ %s', (_name, fps) => {
  it('every accepted op keeps the sequence valid and is exactly reversible (random programs)', () => {
    const totals = new Map<string, number>();
    let accepted = 0;
    let rejected = 0;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const r = rig(fps);
        const s = runProgram(r, seed, 45);
        accepted += s.accepted;
        rejected += s.rejected;
        for (const [k, v] of s.byType) totals.set(k, (totals.get(k) ?? 0) + v);
      }),
      { numRuns: RUNS },
    );
    // the generator must actually exercise the engine, not just bounce off validation
    expect(accepted / (accepted + rejected)).toBeGreaterThan(0.35);
    for (const t of ['insert', 'split', 'trim', 'move', 'removeRange', 'rippleDelete', 'rippleTrim', 'overwrite', 'setSpeed', 'addKeyframe', 'addTransition']) {
      expect(totals.get(t) ?? 0, `${t} was never accepted`).toBeGreaterThan(0);
    }
    // eslint-disable-next-line no-console
    console.log(`[${_name}] ${accepted} accepted / ${rejected} rejected; ` + [...totals].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
  });

  it('undo-all returns the initial state; redo-all returns the final state; replay is deterministic', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const r = rig(fps);
        const initial = r.ed.state;
        const stats = runProgram(r, seed, 35);
        const final = r.ed.state;
        const n = r.ed.history.length;
        for (let i = 0; i < n; i++) expect(r.ed.undo()).not.toBeNull();
        expect(r.ed.state).toEqual(initial);
        expect(r.ed.canUndo).toBe(false);
        for (let i = 0; i < n; i++) expect(r.ed.redo()).not.toBeNull();
        expect(r.ed.state).toEqual(final);

        // replaying the accepted ops on a fresh sequence reproduces the same state, ids included
        const r2 = rig(fps);
        for (const op of stats.ops) r2.ed.apply(op);
        expect(r2.ed.state).toEqual(final);

        // the sequence round-trips through JSON (it is what project.json stores)
        expect(JSON.parse(JSON.stringify(final))).toEqual(final);
      }),
      { numRuns: Math.max(25, Math.round(RUNS * 0.6)) },
    );
  });
});

describe('transactions group a whole turn atomically', () => {
  it('a multi-op transaction is one undo step and a failure inside it can be rolled back entirely', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const r = rig();
        runProgram(r, seed, 12);
        const before = r.ed.state;
        const depth = r.ed.history.length;
        const rng = mulberry32(seed ^ 0x9e3779b9);

        r.ed.begin('agent turn', 'agent:cutter');
        let applied = 0;
        for (let i = 0; i < 8; i++) {
          try {
            r.ed.apply(randomOp(rng, r, r.ed.working).op);
            applied++;
          } catch (e) {
            if (!(e instanceof EditError)) throw e;
          }
        }
        if (seed % 2 === 0) {
          r.ed.rollback();
          expect(r.ed.state).toBe(before);
          expect(r.ed.history).toHaveLength(depth);
        } else {
          const tx = r.ed.commit('did things');
          if (applied === 0) expect(tx).toBeNull();
          else {
            expect(r.ed.history).toHaveLength(depth + 1);
            expect(tx!.ops).toHaveLength(applied);
            expect(tx!.origin).toBe('agent:cutter');
            r.ed.undo();
            expect(r.ed.state).toEqual(before); // the whole turn reverts as one
            r.ed.redo();
          }
        }
      }),
      { numRuns: Math.max(60, RUNS * 2) },
    );
  });
});

describe('op schema', () => {
  it('rejects malformed operations with a readable message', () => {
    const r = rig();
    const bad = (o: unknown) => () => applyOp(r.ed.state, o as Op, r.env);
    expect(bad({ type: 'nope' })).toThrow(/Invalid operation/);
    expect(bad({ type: 'split', clipId: 'c1', at: 1.5 })).toThrow(/at/);
    expect(bad({ type: 'insert', at: 0, clips: [] })).toThrow(/Invalid operation/);
    expect(bad({ type: 'setClipProps', clipId: 'c1', patch: { transform: { opacity: 3 } } })).toThrow(/opacity/);
  });

  it('applies schema defaults (linked, ripple, snap…)', () => {
    const r = rig();
    const res = applyOp(r.ed.state, { type: 'addMarker', time: 0, label: 'x' }, r.env);
    expect(res.op).toMatchObject({ type: 'addMarker', time: 0, label: 'x' });
    const split = (() => {
      try {
        return applyOp(r.ed.state, { type: 'split', clipId: 'zzz', at: 0 }, r.env);
      } catch (e) {
        return e as EditError;
      }
    })();
    expect(split).toBeInstanceOf(EditError);
    expect((split as EditError).code).toBe('not_found');
  });

  it('every op type in the schema has a handler (no op is parse-only)', () => {
    const r = rig();
    // a deliberately invalid-but-well-formed instance of each op must fail with an EditError, not "no handler"
    const probes: ParsedOp[] = [
      { type: 'delete', itemIds: ['nope'], linked: true },
      { type: 'removeMarker', id: 'nope' },
      { type: 'moveTrack', trackId: 'nope', toIndex: 0 },
    ];
    for (const p of probes) expect(() => applyOp(r.ed.state, p, r.env)).toThrow(EditError);
  });
});

describe('Editor', () => {
  it('commits nothing for a transaction in which nothing changed', () => {
    const r = rig();
    r.ed.begin('noop');
    expect(r.ed.commit()).toBeNull();
    expect(r.ed.history).toHaveLength(0);
    expect(r.ed.revision).toBe(0);
  });

  it('emits patches for commit, undo and redo, and revision only moves forward', () => {
    const r = rig();
    const events: string[] = [];
    r.ed.subscribe((e) => events.push(`${e.type}@${e.revision}`));
    r.ed.apply({ type: 'addMarker', time: 0, label: 'a' });
    r.ed.apply({ type: 'addMarker', time: 100, label: 'b' });
    r.ed.undo();
    r.ed.redo();
    expect(events).toEqual(['commit@1', 'commit@2', 'undo@3', 'redo@4']);
  });

  it('a new edit clears the redo stack; undo/redo are refused mid-transaction', () => {
    const r = rig();
    r.ed.apply({ type: 'addMarker', time: 0, label: 'a' });
    r.ed.undo();
    expect(r.ed.canRedo).toBe(true);
    r.ed.apply({ type: 'addMarker', time: 5, label: 'b' });
    expect(r.ed.canRedo).toBe(false);
    r.ed.begin('x');
    expect(() => r.ed.undo()).toThrow(/open transaction/);
    expect(() => r.ed.begin('y')).toThrow(/already open/);
    r.ed.rollback();
  });

  it('coalesces consecutive same-key edits (slider drags) into one undo step', () => {
    let t = 0;
    const base = rig();
    const ed = new Editor(base.seq, base.env, { coalesceMs: 500, now: () => (t += 100) });
    ed.apply({ type: 'addMarker', time: 0, label: 'm' });
    const id = ed.state.markers[0]!.id;
    for (let i = 1; i <= 5; i++) ed.apply({ type: 'setMarker', id, patch: { time: i * 10 } }, { coalesceKey: 'drag' });
    expect(ed.history).toHaveLength(2);
    expect(ed.state.markers[0]!.time).toBe(50);
    ed.undo();
    expect(ed.state.markers[0]!.time).toBe(0);
    ed.redo();
    expect(ed.state.markers[0]!.time).toBe(50);
  });

  it('caps history length', () => {
    const base = rig();
    const ed = new Editor(base.seq, base.env, { maxHistory: 3 });
    for (let i = 0; i < 6; i++) ed.apply({ type: 'addMarker', time: i, label: `m${i}` });
    expect(ed.history).toHaveLength(3);
    for (let i = 0; i < 3; i++) ed.undo();
    expect(ed.state.markers).toHaveLength(3); // the three oldest edits can no longer be undone
  });

  it('validateSequence reports a hand-corrupted sequence instead of throwing', () => {
    const r = rig();
    r.ed.apply({ type: 'insert', at: 0, clips: [{ trackId: r.ids.V1, mediaId: 'v', sourceIn: 0, sourceOut: r.s(2) }] });
    r.ed.apply({ type: 'insert', at: r.f(60), clips: [{ trackId: r.ids.V1, mediaId: 'v', sourceIn: 0, sourceOut: r.s(2) }] });
    const corrupt = structuredClone(r.ed.state);
    const items = Object.values(corrupt.tracks[0]!.items);
    items[1]!.start = 10; // overlapping, off-grid
    const issues = validateSequence(corrupt, r.env);
    expect(hasErrors(issues)).toBe(true);
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(['overlap', 'grid']));
  });
});
