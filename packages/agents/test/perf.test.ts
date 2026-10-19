import { describe, expect, it } from 'vitest';
import { Editor, type EditEnv, type Op, buildClip, createSequence, mediaRef } from '@cutroom/core';
import { HostEditError, runAgent } from '../src';
import { ANALYSIS, FPS, media, scripted } from './helpers';

/** Spec: agent tool calls execute in < 50 ms (model latency excluded) on a timeline with 1,000+ clips. */
describe('agent tool latency on a 1,200-clip timeline', () => {
  function bigHost(llm: ReturnType<typeof scripted>) {
    const seq = createSequence({ width: 1920, height: 1080, fps: FPS });
    const f = seq.timebase.rate / 30; // ticks per frame
    const v = seq.tracks.find((t) => t.name === 'V1')!;
    const a = seq.tracks.find((t) => t.name === 'A1')!;
    for (let i = 0; i < 600; i++) {
      const g = `g${1000 + i}`;
      const base = { mediaId: 'm_int', start: i * 20 * f, duration: 20 * f, sourceIn: (i % 50) * 20 * f, linkGroupId: g };
      v.items[`cv${i}`] = buildClip(`cv${i}`, { ...base, trackId: v.id });
      a.items[`ca${i}`] = buildClip(`ca${i}`, { ...base, trackId: a.id });
    }
    seq.nextId = 5000;
    const list = [media('m_int', 'interview.mp4', 60), media('m_broll', 'broll.mp4', 30, { audio: false })];
    const env: EditEnv = { getMedia: (id) => (list.find((m) => m.id === id) ? mediaRef(list.find((m) => m.id === id)!, seq.timebase) : undefined) };
    const editor = new Editor(seq, env);
    return {
      llm,
      editor,
      env,
      sequence: () => editor.state,
      media: () => list,
      analysis: async (id: string, kind: keyof (typeof ANALYSIS)['m_int']) => ANALYSIS[id]?.[kind] ?? null,
      applyOps(ops: Op[], o: { label: string; origin: string; group: string }) {
        editor.begin(o.label, o.origin as never, o.group);
        try {
          for (const op of ops) editor.apply(op);
        } catch (e) {
          editor.rollback();
          throw new HostEditError(e instanceof Error ? e.message : String(e));
        }
        editor.commit();
        return { revision: editor.revision };
      },
    };
  }

  it('every read and edit tool call finishes within 50 ms', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [
      { name: 'get_overview', args: {} },
      { name: 'list_media', args: {} },
      { name: 'get_sequence', args: { from: 100, to: 130 } },
      { name: 'get_sequence', args: { track: 'V1', from: 0, to: 60 } },
      { name: 'get_transcript', args: { mediaId: 'm_int' } },
      { name: 'get_words', args: { mediaId: 'm_int', from: 0, to: 10 } },
      { name: 'search_transcript', args: { mediaId: 'm_int', query: 'anyway' } },
      { name: 'get_silences', args: { mediaId: 'm_int' } },
      { name: 'get_scenes', args: { mediaId: 'm_int' } },
      { name: 'get_beats', args: { mediaId: 'm_int' } },
      { name: 'get_loudness', args: { mediaId: 'm_int' } },
      { name: 'validate', args: {} },
      { name: 'split', args: { clipId: 'cv300', at: 300 * 20 / 30 + 0.3 } },
      { name: 'trim', args: { clipId: 'cv100', edge: 'end', to: 100 * 20 / 30 + 0.4 } },
      { name: 'set_clip', args: { clipId: 'ca200', gainDb: -3 } },
      { name: 'set_speed', args: { clipId: 'cv450', speed: 2 } },
      { name: 'add_keyframes', args: { clipId: 'cv400', property: 'opacity', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 1 }] } },
      { name: 'apply_effect', args: { clipId: 'cv500', type: 'blur' } },
      { name: 'add_marker', args: { time: 10, label: 'here' } },
      { name: 'remove_range', args: { from: 399.5, to: 400 } },
      { name: 'add_transition', args: { clipId: 'cv10', type: 'dissolve', seconds: 0.3 } },
    ];
    const llm = scripted([() => ({ calls }), () => ({ text: 'done' })]);
    const host = bigHost(llm);
    const marks = new Map<string, number>();
    const times: { name: string; ms: number; ok: boolean }[] = [];
    // warm up V8 once, like a long-running server would be
    await runAgent(bigHost(scripted([() => ({ calls: calls.slice(0, 12) }), () => ({ text: 'x' })])), { runId: 'w', prompt: 'x', mode: 'auto', effort: 'off', model: 'm', emit: () => undefined, approve: async () => true });
    await runAgent(host, {
      runId: 'perf',
      prompt: 'benchmark',
      mode: 'auto',
      effort: 'off',
      model: 'm',
      emit: (e) => {
        if (e.type === 'tool_call') marks.set(e.id, performance.now());
        if (e.type === 'tool_result') times.push({ name: e.tool, ms: performance.now() - marks.get(e.id)!, ok: e.ok });
      },
      approve: async () => true,
    });
    expect(times).toHaveLength(calls.length);
    // eslint-disable-next-line no-console
    console.log('1,200 clips, tool latency:', times.map((t) => `${t.name} ${t.ms.toFixed(1)}ms${t.ok ? '' : ' (rejected)'}`).join(' · '));
    for (const t of times) expect(t.ms, `${t.name} took ${t.ms.toFixed(1)} ms`).toBeLessThan(50);
  });
});
