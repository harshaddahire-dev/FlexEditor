import { describe, expect, it } from 'vitest';
import { type Clip, allClips, createSequence, validateSequence } from '@cutroom/core';
import { ROLES, SPECIALISTS, describeSequence, parseTime, runAgent, toolSpecsFor, type RunOptions } from '../src';
import { FPS, collect, frame, makeHost, scripted } from './helpers';

const base = (emit: RunOptions['emit'], over: Partial<RunOptions> = {}): RunOptions => ({
  runId: 'r1',
  prompt: 'tighten it up',
  mode: 'auto',
  effort: 'medium',
  model: 'test-model',
  emit,
  approve: async () => true,
  ...over,
});

const sec = (host: ReturnType<typeof makeHost>, ticks: number) => ticks / host.sequence().timebase.rate;
const clips = (host: ReturnType<typeof makeHost>): Clip[] => allClips(host.sequence()).sort((a, b) => a.start - b.start);

describe('parseTime', () => {
  const tb = createSequence({ width: 1920, height: 1080, fps: FPS }).timebase;
  it('reads seconds, m:ss, timecode, ms and frames, snapped to the frame grid', () => {
    const F = frame(createSequence({ width: 1920, height: 1080, fps: FPS }));
    expect(parseTime(12.5, tb)).toBe(12.5 * tb.rate);
    expect(parseTime('12.5s', tb)).toBe(12.5 * tb.rate);
    expect(parseTime('1:02.5', tb)).toBe(62.5 * tb.rate);
    expect(parseTime('00:01:02:15', tb)).toBe(62.5 * tb.rate);
    expect(parseTime('500ms', tb)).toBe(0.5 * tb.rate);
    expect(parseTime('45f', tb)).toBe(45 * F);
    expect(parseTime(0.01, tb)).toBe(0); // rounds to the nearest frame
    expect(() => parseTime('soon', tb)).toThrow(/Cannot read/);
    expect(() => parseTime(NaN, tb)).toThrow();
  });
});

describe('roles and tool schemas', () => {
  it('every role only lists tools that exist, and QA cannot edit', () => {
    for (const r of ['director', ...SPECIALISTS] as const) {
      const specs = toolSpecsFor(r);
      expect(specs.map((s) => s.name).sort()).toEqual([...ROLES[r].tools].sort());
      for (const s of specs) expect(s.parameters.type).toBe('object');
    }
    const edits = ['add_clip', 'split', 'trim', 'delete_clips', 'remove_range', 'move_clips', 'set_speed', 'set_clip', 'set_track', 'add_marker', 'add_keyframes', 'delegate'];
    for (const e of edits) expect(ROLES.qa.tools).not.toContain(e);
    expect(ROLES.director.tools).toContain('delegate');
    for (const s of SPECIALISTS) expect(ROLES[s].tools).not.toContain('delegate');
  });
});

describe('runAgent — Director', () => {
  it('reads, edits through the engine and reports; every edit shares one group and agent origin', async () => {
    const llm = scripted([
      () => ({ text: 'Let me look.', calls: [{ name: 'get_overview', args: {} }] }),
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_int', at: 0, sourceIn: 0, sourceOut: 20 } }] }),
      () => ({ calls: [{ name: 'split', args: { clipId: 'c6', at: 8 } }] }),
      () => ({ calls: [{ name: 'remove_range', args: { from: 5, to: 8 } }] }),
      () => ({ text: 'Removed the filler between 5 and 8 seconds.' }),
    ]);
    const host = makeHost(llm);
    const { events, emit } = collect();
    const r = await runAgent(host, base(emit));

    expect(r.summary).toBe('Removed the filler between 5 and 8 seconds.');
    expect(r.cancelled).toBe(false);
    expect(r.edits).toBe(3);
    const cs = clips(host).filter((c) => c.trackId === host.sequence().tracks.find((t) => t.name === 'V1')!.id);
    expect(cs.map((c) => [sec(host, c.start), sec(host, c.duration)])).toEqual([[0, 5], [5, 12]]); // 20 s − 3 s removed
    expect(allClips(host.sequence()).every((c) => c.createdBy === 'agent:director' && !c.accepted)).toBe(true);
    expect(host.calls.every((c) => c.group === 'run_r1' && c.origin === 'agent:director')).toBe(true);
    expect(host.editor.history.every((t) => t.group === 'run_r1')).toBe(true);
    expect(validateSequence(host.sequence(), host.env).filter((i) => i.severity === 'error')).toEqual([]);

    expect(events.map((e) => e.type)).toEqual(['run_start', 'text', 'usage', 'tool_call', 'tool_result', 'usage', 'tool_call', 'tool_result', 'usage', 'tool_call', 'tool_result', 'usage', 'tool_call', 'tool_result', 'text', 'usage', 'done']);
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: 'done', edits: 3, cancelled: false, group: 'run_r1' });

    // the model saw seconds, not ticks, and learned the new clip ids from the result
    const toolMsgs = llm.requests[2]!.messages.filter((m) => m.role === 'tool');
    expect(JSON.parse(toolMsgs[1]!.content).newClips[0]).toMatchObject({ id: 'c6', track: 'V1', start: 0, end: 20, mediaId: 'm_int' });

    // the whole run undoes as one
    expect(host.editor.undoGroup('run_r1')).toBe(3);
    expect(allClips(host.sequence())).toHaveLength(0);
  });

  it('tells the model about tool failures and lets it recover', async () => {
    const llm = scripted([
      () => ({ calls: [{ name: 'split', args: { clipId: 'nope', at: 1 } }, { name: 'add_clip', args: { mediaId: 'ghost', at: 0 } }, { name: 'trim', args: { clipId: 'c1' } }] }),
      () => ({ text: 'ok' }),
    ]);
    const host = makeHost(llm);
    const { events, emit } = collect();
    const r = await runAgent(host, base(emit));
    expect(r.edits).toBe(0);
    const results = llm.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    expect(results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/No clip "nope"/) });
    expect(results[1]).toMatchObject({ ok: false, error: expect.stringMatching(/No media "ghost"/) });
    expect(results[2].error).toMatch(/Invalid arguments/);
    expect(events.filter((e) => e.type === 'tool_result' && !e.ok)).toHaveLength(3);
  });

  it('relays engine rejections with the reason (an overlapping move)', async () => {
    const llm = scripted([
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_int', at: 0, sourceIn: 0, sourceOut: 10 } }, { name: 'add_clip', args: { mediaId: 'm_broll', at: 10, sourceIn: 0, sourceOut: 10, videoTrack: 'V1' } }] }),
      () => ({ calls: [{ name: 'move_clips', args: { clipIds: [Object.values(host.sequence().tracks.find((t) => t.name === 'V1')!.items).find((c) => c.start === 10 * 48000)!.id], to: 5 } }] }),
      () => ({ text: 'could not' }),
    ]);
    const host: ReturnType<typeof makeHost> = makeHost(llm);
    await runAgent(host, base(collect().emit));
    const reply = JSON.parse(llm.requests[2]!.messages.filter((m) => m.role === 'tool').at(-1)!.content);
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/rejected/);
  });

  it('keeps going to the step limit at most', async () => {
    const llm = scripted([() => ({ calls: [{ name: 'get_overview', args: {} }] })]);
    const host = makeHost(llm);
    const r = await runAgent(host, base(collect().emit, { maxSteps: 3 }));
    expect(llm.requests).toHaveLength(3);
    expect(r.summary).toMatch(/Stopped after 3 steps/);
  });
});

describe('approvals', () => {
  const script = () =>
    scripted([
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_int', at: 0, sourceIn: 0, sourceOut: 10 } }] }),
      () => ({ calls: [{ name: 'split', args: { clipId: 'c6', at: 4 } }] }),
      () => ({ calls: [{ name: 'split', args: { clipId: 'c6', at: 2 } }] }),
      () => ({ text: 'done' }),
    ]);

  it('Ask mode waits for a decision on every edit; a decline reaches the model and changes nothing', async () => {
    const llm = script();
    const host = makeHost(llm);
    const { events, emit } = collect();
    const asked: string[] = [];
    const r = await runAgent(host, base(emit, { mode: 'ask', approve: async (q) => (asked.push(q.summary), q.tool !== 'split') }));
    expect(asked).toHaveLength(3);
    expect(asked[0]).toBe('Add m_int at 0');
    expect(asked[1]).toBe('Split c6 at 4');
    expect(events.filter((e) => e.type === 'approval')).toHaveLength(3);
    expect(allClips(host.sequence())).toHaveLength(2); // only the add happened (video + audio)
    expect(r.edits).toBe(1);
    const declined = JSON.parse(llm.requests[2]!.messages.filter((m) => m.role === 'tool').at(-1)!.content);
    expect(declined).toMatchObject({ ok: false, declined: true });
  });

  it('"always" approves the rest of the run', async () => {
    const host = makeHost(script());
    let n = 0;
    await runAgent(host, base(collect().emit, { mode: 'ask', approve: async () => (++n === 1 ? 'always' : false) }));
    expect(n).toBe(1);
    expect(host.editor.history).toHaveLength(3);
  });

  it('Auto mode never asks', async () => {
    const host = makeHost(script());
    let n = 0;
    await runAgent(host, base(collect().emit, { mode: 'auto', approve: async () => (n++, true) }));
    expect(n).toBe(0);
    expect(host.editor.history).toHaveLength(3);
  });

  it('reads never need approval, even in Ask mode', async () => {
    const llm = scripted([() => ({ calls: [{ name: 'get_overview', args: {} }, { name: 'validate', args: {} }] }), () => ({ text: 'fine' })]);
    let n = 0;
    await runAgent(makeHost(llm), base(collect().emit, { mode: 'ask', approve: async () => (n++, true) }));
    expect(n).toBe(0);
  });
});

describe('delegation', () => {
  it('a specialist works with its own prompt and tools; its edits join the run; its report returns to the Director', async () => {
    const llm = scripted([
      (_r, n) => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_int', at: 0, sourceIn: 0, sourceOut: 20 } }], text: `d${n}` }),
      () => ({ calls: [{ name: 'delegate', args: { role: 'audio', task: 'Set clip c7 to -6 dB with a 20 ms fade-in.' } }] }),
      (req) => {
        // the specialist's first request: audio role prompt, no delegate tool, only the task as its user message
        expect(req.messages[0]!.content).toContain('You are the Audio specialist');
        expect(req.tools!.some((t) => t.name === 'delegate')).toBe(false);
        expect(req.messages.at(-1)).toMatchObject({ role: 'user', content: 'Set clip c7 to -6 dB with a 20 ms fade-in.' });
        return { calls: [{ name: 'set_clip', args: { clipId: 'c7', gainDb: -6, fadeInMs: 20 } }] };
      },
      () => ({ text: 'Lowered c7 by 6 dB, added a 20 ms fade.' }),
      () => ({ text: 'All set.' }),
    ]);
    const host = makeHost(llm);
    const { events, emit } = collect();
    const r = await runAgent(host, base(emit));
    expect(r.summary).toBe('All set.');
    const c2 = host.sequence().tracks.flatMap((t) => Object.values(t.items)).find((c) => c.id === 'c7') as Clip;
    expect(c2.audio.gainDb).toBe(-6);
    expect(c2.createdBy).toBe('agent:director'); // created by the Director…
    expect(host.calls.map((c) => c.origin)).toEqual(['agent:director', 'agent:audio']); // …edited by the specialist
    expect(new Set(host.calls.map((c) => c.group))).toEqual(new Set(['run_r1']));
    const roles = events.filter((e) => e.type === 'tool_call').map((e) => (e as { role: string }).role);
    expect(roles).toEqual(['director', 'director', 'audio']);
    const report = JSON.parse(llm.requests[4]!.messages.filter((m) => m.role === 'tool').at(-1)!.content);
    expect(report).toEqual({ role: 'audio', report: 'Lowered c7 by 6 dB, added a 20 ms fade.' });
  });

  it('a specialist cannot call tools outside its set', async () => {
    const llm = scripted([
      () => ({ calls: [{ name: 'delegate', args: { role: 'qa', task: 'Review the edit and report any problems.' } }] }),
      () => ({ calls: [{ name: 'split', args: { clipId: 'c6', at: 1 } }] }), // QA has no split
      () => ({ text: 'No problems found.' }),
      () => ({ text: 'QA says fine.' }),
    ]);
    const host = makeHost(llm);
    await runAgent(host, base(collect().emit));
    const reply = JSON.parse(llm.requests[2]!.messages.filter((m) => m.role === 'tool').at(-1)!.content);
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/Unknown tool "split"/);
    expect(host.calls).toHaveLength(0);
  });
});

describe('QA loop', () => {
  it('feeds problems the run introduced back to the Director, once, and reports them', async () => {
    let host!: ReturnType<typeof makeHost>;
    const v1 = () => host.sequence().tracks.find((t) => t.name === 'V1')!;
    const clipAt = (s: number) => Object.values(v1().items).find((c) => c.start === s * 48000)!.id;
    const llm = scripted([
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_int', at: 0, sourceIn: 0, sourceOut: 10 } }] }),
      () => ({ calls: [{ name: 'split', args: { clipId: clipAt(0), at: 2 } }] }),
      () => ({ calls: [{ name: 'split', args: { clipId: clipAt(2), at: '2.0666667' } }] }),
      () => ({ text: 'Split twice.' }),
      (req) => {
        const last = req.messages.at(-1)!;
        expect(last.role).toBe('user');
        expect(last.content).toMatch(/Automatic QA found problems/);
        expect(last.content).toMatch(/flash_frame/);
        return { calls: [{ name: 'delete_clips', args: { clipIds: [clipAt(2)], ripple: true } }] };
      },
      () => ({ text: 'Removed the 2-frame sliver.' }),
    ]);
    host = makeHost(llm);
    const { events, emit } = collect();
    const r = await runAgent(host, base(emit));
    const qa = events.filter((e) => e.type === 'qa');
    expect(qa).toHaveLength(1);
    expect(qa[0]).toMatchObject({ round: 1, issues: [expect.objectContaining({ code: 'flash_frame' })] });
    expect(r.summary).toBe('Removed the 2-frame sliver.');
    expect(Object.values(v1().items).every((c) => c.duration > 5 * 1600)).toBe(true);
  });

  it('ignores problems that existed before the run', async () => {
    const llm = scripted([() => ({ calls: [{ name: 'add_marker', args: { time: 1, label: 'x' } }] }), () => ({ text: 'ok' })]);
    const host = makeHost(llm);
    // a pre-existing flash frame
    host.editor.apply({ type: 'insert', at: 0, clips: [{ trackId: 't1', mediaId: 'm_broll', sourceIn: 0, sourceOut: 2 * frame(host.sequence()) }] });
    const { events, emit } = collect();
    await runAgent(host, base(emit));
    expect(events.some((e) => e.type === 'qa')).toBe(false);
  });
});

describe('cancellation and failures', () => {
  it('stops on abort; completed edits stay and are undoable as a group', async () => {
    const ctl = new AbortController();
    const llm = scripted([
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_int', at: 0, sourceIn: 0, sourceOut: 10 } }] }),
      () => {
        ctl.abort();
        return { calls: [{ name: 'split', args: { clipId: 'c6', at: 3 } }] };
      },
      () => ({ text: 'never' }),
    ]);
    const host = makeHost(llm);
    const { events, emit } = collect();
    const r = await runAgent(host, base(emit, { signal: ctl.signal }));
    expect(r.cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', cancelled: true });
    expect(allClips(host.sequence())).toHaveLength(2); // the add happened, the split did not
    expect(host.editor.undoGroup('run_r1')).toBe(1);
  });

  it('a model/provider error ends the run cleanly with the error shown', async () => {
    const llm = { async *stream() { throw new Error('429 Rate limited'); } };
    const { events, emit } = collect();
    const r = await runAgent(makeHost(llm as never), base(emit));
    expect(events.some((e) => e.type === 'error' && e.message.includes('Rate limited'))).toBe(true);
    expect(r.summary).toMatch(/Stopped: 429/);
  });
});

describe('describeSequence', () => {
  it('speaks seconds and caps long timelines', async () => {
    const host = makeHost(scripted([() => ({ text: '' })]));
    for (let i = 0; i < 12; i++) host.editor.apply({ type: 'insert', at: i * 30 * 1600, clips: [{ trackId: 't1', mediaId: 'm_broll', sourceIn: 0, sourceOut: 30 * 1600 }] });
    const v = describeSequence(host.sequence(), host.media(), { limit: 5 });
    expect(v.clips).toHaveLength(5);
    expect(v.truncated).toMatch(/5 of 12/);
    expect(v.clips[1]).toMatchObject({ start: 1, end: 2, duration: 1, track: 'V1', media: 'broll.mp4' });
    expect(v.fps).toBe(30);
    const narrowed = describeSequence(host.sequence(), host.media(), { from: 3, to: 5 });
    expect(narrowed.clips.map((c) => c.start)).toEqual([3, 4]);
  });
});
