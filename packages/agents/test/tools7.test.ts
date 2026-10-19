import { describe, expect, it } from 'vitest';
import { type Clip, allClips, isCaption, trackItems } from '@cutroom/core';
import { type RunOptions, runAgent } from '../src';
import { collect, makeHost, scripted } from './helpers';

const base = (emit: RunOptions['emit'], over: Partial<RunOptions> = {}): RunOptions => ({ runId: 'r7', prompt: 'polish it', mode: 'auto', effort: 'off', model: 'm', emit, approve: async () => true, ...over });
/** Every tool result of the run, in call order (the last request carries the whole conversation). */
const results = (llm: ReturnType<typeof scripted>) => llm.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
const v1 = (host: ReturnType<typeof makeHost>) => trackItems(host.sequence().tracks.find((t) => t.name === 'V1')!).filter((i): i is Clip => i.kind === 'clip');

describe('transition and effect tools', () => {
  it('adds a transition at a cut, shortened to the footage that exists, then swaps its type', async () => {
    let host!: ReturnType<typeof makeHost>;
    const llm = scripted([
      // two clips from different parts of a 60 s file: lots of handle on both sides
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_int', at: 0, sourceIn: 10, sourceOut: 15 } }, { name: 'add_clip', args: { mediaId: 'm_int', at: 5, sourceIn: 30, sourceOut: 35 } }] }),
      () => ({ calls: [{ name: 'add_transition', args: { clipId: v1(host)[0]!.id, type: 'dissolve', seconds: 1 } }] }),
      () => ({ calls: [{ name: 'add_transition', args: { clipId: v1(host)[0]!.id, type: 'wipe-left' } }] }),
      () => ({ text: 'done' }),
    ]);
    host = makeHost(llm);
    await runAgent(host, base(collect().emit));
    const track = host.sequence().tracks.find((t) => t.name === 'V1')!;
    expect(track.transitions).toHaveLength(1);
    expect(track.transitions[0]).toMatchObject({ type: 'wipe-left', alignment: 'center' });
    expect(results(llm)[2]).toMatchObject({ ok: true, transition: 'dissolve', seconds: 1 });
    expect(results(llm)[3]).toMatchObject({ ok: true, transition: 'wipe-left' });
  });

  it('refuses a transition with no spare footage, saying why, and shortens one that is too long', async () => {
    let host!: ReturnType<typeof makeHost>;
    const llm = scripted([
      // clip A uses media 0–5 s (no head), clip B uses 5–10 s directly after: A has tail handle, B has head handle…
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_broll', at: 0, sourceIn: 0, sourceOut: 5 } }, { name: 'add_clip', args: { mediaId: 'm_broll', at: 5, sourceIn: 29.8, sourceOut: 30 } }] }),
      () => ({ calls: [{ name: 'add_transition', args: { clipId: v1(host)[0]!.id, type: 'dissolve', seconds: 2 } }, { name: 'add_transition', args: { clipId: v1(host)[1]!.id, type: 'dissolve' } }] }),
      () => ({ text: 'done' }),
    ]);
    host = makeHost(llm);
    await runAgent(host, base(collect().emit));
    const [, , first, second] = results(llm);
    // second clip has nothing after it
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/no clip touching its end/) });
    // first cut: B starts at media 29.8 s with only ~0.2 s... head = 29.8 s of handle but A's tail is large; limited by the 0.2 s clip (cannot exceed 2× shorter)
    expect(first.ok).toBe(true);
    expect(first.seconds).toBeLessThanOrEqual(0.4);
    expect(first.note).toMatch(/Shortened/);
  });

  it('validates effects before touching the timeline', async () => {
    let host!: ReturnType<typeof makeHost>;
    const llm = scripted([
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_int', at: 0, sourceIn: 0, sourceOut: 5 } }] }),
      () => ({
        calls: [
          { name: 'apply_effect', args: { clipId: v1(host)[0]!.id, type: 'glow' } },
          { name: 'apply_effect', args: { clipId: v1(host)[0]!.id, type: 'blur', params: { radius: 500 } } },
          { name: 'apply_effect', args: { clipId: v1(host)[0]!.id, type: 'blur', params: { sigma: 1 } } },
          { name: 'apply_effect', args: { clipId: allClips(host.sequence()).find((c) => c.trackId.startsWith('t3'))!.id, type: 'blur' } },
          { name: 'apply_effect', args: { clipId: v1(host)[0]!.id, type: 'color', params: { saturation: 0, contrast: 0.2 } } },
        ],
      }),
      () => ({ calls: [{ name: 'set_effect', args: { clipId: v1(host)[0]!.id, type: 'color', params: { saturation: 0.5 } } }, { name: 'set_effect', args: { clipId: v1(host)[0]!.id, type: 'blur', params: { radius: 3 } } }] }),
      () => ({ calls: [{ name: 'remove_effect', args: { clipId: v1(host)[0]!.id, type: 'color' } }] }),
      () => ({ text: 'done' }),
    ]);
    host = makeHost(llm);
    await runAgent(host, base(collect().emit));
    const all = results(llm);
    const r = all.slice(1, 6);
    expect(r[0].error).toMatch(/Unknown effect "glow"/);
    expect(r[1].error).toMatch(/between 0 and 60/);
    expect(r[2].error).toMatch(/no parameter "sigma"/);
    expect(r[3].error).toMatch(/video clips/);
    expect(r[4]).toMatchObject({ ok: true, effectId: expect.stringMatching(/^e\d+/) });
    const s = all.slice(6, 8);
    expect(s[0].ok).toBe(true);
    expect(s[1].error).toMatch(/No matching effect/);
    expect(v1(host)[0]!.effects).toEqual([]); // removed at the end
  });
});

describe('caption tools', () => {
  it('builds captions from the transcript that follow the clip, then restyles them', async () => {
    let host!: ReturnType<typeof makeHost>;
    const llm = scripted([
      // media 4–7 s of the interview, placed at 10 s: words "Um anyway." (5.0–6.0 s of media) land at 11–12 s
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_int', at: 10, sourceIn: 4, sourceOut: 7 } }] }),
      () => ({ calls: [{ name: 'add_captions', args: { style: 'bold-pop' } }] }),
      () => ({ calls: [{ name: 'get_captions', args: {} }, { name: 'style_captions', args: { style: 'minimal', y: 0.9 } }, { name: 'style_captions', args: { style: 'neon' } }] }),
      () => ({ text: 'Captions added.' }),
    ]);
    host = makeHost(llm);
    await runAgent(host, base(collect().emit));
    const seq = host.sequence();
    const caps = seq.tracks.filter((t) => t.kind === 'caption').flatMap((t) => Object.values(t.items)).filter(isCaption);
    expect(caps).toHaveLength(1);
    const R = seq.timebase.rate;
    expect(caps[0]!.words.map((w) => w.text)).toEqual(['Um', 'anyway.']);
    expect(caps[0]!.words[0]!.start).toBe(11 * R); // media 5.0 s → timeline 11.0 s
    expect(caps[0]!.createdBy).toBe('agent:director');
    expect(caps[0]!.styleId).toBe('minimal');
    expect(caps[0]!.position).toEqual({ x: 0.5, y: 0.9 });
    const r = results(llm).slice(2); // get_captions, style, style
    expect(r[0]).toEqual({ items: [expect.objectContaining({ text: 'Um anyway.', style: 'bold-pop', start: 11 })] });
    expect(r[2].error).toMatch(/Unknown caption style "neon"/);
    // every caption edit of the run shares the group, including creating the track
    expect(host.editor.history.every((t) => t.group === 'run_r7')).toBe(true);
  });

  it('reports a missing transcript instead of inventing captions, and unknown styles up front', async () => {
    let host!: ReturnType<typeof makeHost>;
    const llm = scripted([
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_broll', at: 0, sourceIn: 0, sourceOut: 5 } }] }),
      () => ({ calls: [{ name: 'add_captions', args: {} }, { name: 'add_captions', args: { style: 'neon' } }, { name: 'style_captions', args: { style: 'minimal' } }] }),
      () => ({ text: 'ok' }),
    ]);
    host = makeHost(llm);
    await runAgent(host, base(collect().emit));
    const r = results(llm).slice(1);
    expect(r[0].error).toMatch(/No transcript for broll\.mp4/);
    expect(r[1].error).toMatch(/Unknown caption style/);
    expect(r[2].error).toMatch(/no captions yet/i);
    expect(host.sequence().tracks.some((t) => t.kind === 'caption')).toBe(false);
  });
});
