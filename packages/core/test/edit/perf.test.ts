import { describe, expect, it } from 'vitest';
import { freeze } from 'immer';
import { type Op, type Sequence, applyOp, buildClip, validateSequence } from '../../src';
import { rig } from './helpers';

/** Spec §12: agent tool calls execute in < 50 ms (excluding model latency), with 1,000+ clips on the timeline. */
describe('edit latency on a 1,200-clip sequence', () => {
  function bigSequence() {
    const r = rig();
    // build directly (not via 1,200 ops) so the setup stays quick: 600 linked A/V pairs of 20 frames each
    const seq: Sequence = structuredClone(r.seq);
    const v = seq.tracks.find((t) => t.name === 'V1')!;
    const a = seq.tracks.find((t) => t.name === 'A1')!;
    for (let i = 0; i < 600; i++) {
      const g = `g${1000 + i}`;
      const base = { mediaId: 'av', start: i * r.f(20), duration: r.f(20), sourceIn: (i % 50) * r.f(20), linkGroupId: g };
      v.items[`cv${i}`] = buildClip(`cv${i}`, { ...base, trackId: v.id });
      a.items[`ca${i}`] = buildClip(`ca${i}`, { ...base, trackId: a.id });
    }
    seq.nextId = 5000;
    return { r, seq: freeze(seq, true) }; // what Editor does at load
  }

  const time = (r: ReturnType<typeof rig>, seq: Sequence, op: Op): { ms: number; patches: number } => {
    // best of three: we are measuring what the engine needs, not what a busy CI neighbour steals
    let best = Infinity;
    let patches = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const res = applyOp(seq, op, r.env);
      best = Math.min(best, performance.now() - t0);
      patches = res.patches.length;
    }
    return { ms: best, patches };
  };

  it('operations that touch a handful of clips complete in under 50 ms (spec §12)', () => {
    const { r, seq } = bigSequence();
    expect(validateSequence(seq, r.env, {}).filter((i) => i.severity === 'error')).toEqual([]);
    // the very first call in a process pays V8 compilation (~40 ms); a long-running server pays that once
    applyOp(seq, { type: 'split', clipId: 'cv299', at: r.f(299 * 20 + 3) }, r.env);
    const ops: [string, Op][] = [
      ['split (linked)', { type: 'split', clipId: 'cv300', at: r.f(300 * 20 + 7) }],
      ['trim', { type: 'trim', clipId: 'cv100', edge: 'end', to: r.f(100 * 20 + 15) }],
      ['move', { type: 'move', clipIds: ['cv10'], delta: r.f(13000) }], // into empty space past the end
      ['addKeyframe', { type: 'addKeyframe', clipId: 'cv400', prop: 'opacity', keyframe: { time: r.f(5), value: 1, interpolation: 'linear' } }],
      ['setSpeed', { type: 'setSpeed', clipId: 'cv450', speed: { num: 2, den: 1 } }],
      ['applyEffect', { type: 'applyEffect', clipId: 'cv500', effect: { type: 'blur', params: { radius: 3 } } }],
      ['addMarker', { type: 'addMarker', time: r.f(100), label: 'x' }],
    ];
    const out: string[] = [];
    for (const [name, op] of ops) {
      const { ms, patches } = time(r, seq, op);
      out.push(`${name} ${ms.toFixed(1)}ms`);
      expect(patches).toBeGreaterThan(0);
      expect(ms, `${name} took ${ms.toFixed(1)} ms`).toBeLessThan(50);
    }
    // eslint-disable-next-line no-console
    console.log('1,200 clips, local edits:', out.join(' · '));
  });

  it('ripples that shift ~1,000 clips (edit near the start of a long timeline) stay under 150 ms', () => {
    const { r, seq } = bigSequence();
    applyOp(seq, { type: 'split', clipId: 'cv299', at: r.f(299 * 20 + 3) }, r.env);
    const ops: [string, Op][] = [
      ['rippleTrim', { type: 'rippleTrim', clipId: 'cv50', edge: 'end', to: r.f(50 * 20 + 10) }],
      ['rippleDelete', { type: 'rippleDelete', clipIds: ['cv20'] }],
      ['removeRange', { type: 'removeRange', start: r.f(400), end: r.f(440) }],
      ['insert (ripple all)', { type: 'insert', at: r.f(400), clips: [{ trackId: 't1', mediaId: 'av', sourceIn: 0, sourceOut: r.s(2), link: 'x' }, { trackId: 't3', mediaId: 'av', sourceIn: 0, sourceOut: r.s(2), link: 'x' }] }],
    ];
    const out: string[] = [];
    for (const [name, op] of ops) {
      const { ms, patches } = time(r, seq, op);
      out.push(`${name} ${ms.toFixed(0)}ms (${patches} patches)`);
      expect(ms, `${name} took ${ms.toFixed(1)} ms`).toBeLessThan(150);
    }
    // eslint-disable-next-line no-console
    console.log('1,200 clips, bulk ripples:', out.join(' · '));
  });

  it('patches stay small: one split on 1,200 clips is a handful of field-level changes, not the whole track', () => {
    const { r, seq } = bigSequence();
    const res = applyOp(seq, { type: 'split', clipId: 'cv300', at: r.f(300 * 20 + 7) }, r.env);
    const bytes = JSON.stringify(res.patches).length;
    // eslint-disable-next-line no-console
    console.log(`split on 1,200 clips: ${res.patches.length} patches, ${bytes} bytes (inverse ${JSON.stringify(res.inverse).length} bytes)`);
    expect(res.patches.length).toBeLessThan(40);
    expect(bytes).toBeLessThan(20_000);
    expect(JSON.stringify(res.inverse).length).toBeLessThan(20_000);
  });

  it('a 20-op agent transaction (silence removal) stays interactive', () => {
    const { r, seq } = bigSequence();
    r.ed.load(seq);
    const t0 = performance.now();
    r.ed.begin('remove silences', 'agent:cutter');
    for (let i = 0; i < 20; i++) r.ed.apply({ type: 'removeRange', start: r.f(11000 - i * 400), end: r.f(11000 - i * 400 + 12) });
    r.ed.commit('Removed 20 silences');
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`20 removeRange ops in one transaction on 1,200 clips: ${ms.toFixed(0)} ms (${(ms / 20).toFixed(1)} ms each)`);
    expect(ms / 20).toBeLessThan(50);
    expect(validateSequence(r.ed.state, r.env).filter((i) => i.severity === 'error')).toEqual([]);
    r.ed.undo();
    expect(r.ed.state).toEqual(seq);
  });
});
