import { type Media, type Sequence, type Voice } from '@cutroom/core';
import { type F32, SLICE_SAMPLES, type Slice, bakeSlice, slicesOf, sourceRange } from './mix';
import { pcmFor } from './sources';
import type { PcmSource } from './pcm';

export interface Baked {
  sample: number;
  frames: number;
  data: [F32, F32];
}

/** Resolve the PCM source of every voice (null = no audio proxy yet: that voice is silent). */
export async function openSources(voices: Voice[], media: Record<string, Media>): Promise<Map<string, PcmSource | null>> {
  const out = new Map<string, PcmSource | null>();
  await Promise.all(
    [...new Set(voices.map((v) => v.mediaId))].map(async (id) => {
      const m = media[id];
      const p = m ? pcmFor(m) : null;
      out.set(id, p ? await p.catch(() => null) : null);
    }),
  );
  return out;
}

/**
 * Bake every voice's audio for timeline samples `[from, to)`, one slice at a time. Pure with respect to the
 * sequence and the files: the live graph and the offline render both call this, so they play the same samples.
 */
export async function bakeWindow(seq: Sequence, voices: Voice[], sources: Map<string, PcmSource | null>, from: number, to: number): Promise<Baked[]> {
  const tb = seq.timebase;
  const jobs: Promise<Baked | null>[] = [];
  for (const v of voices) {
    const src = sources.get(v.mediaId);
    if (!src) continue;
    for (const s of slicesOf(v, tb, from, to)) jobs.push(bake(v, s, src));
  }
  async function bake(v: Voice, s: Slice, src: PcmSource): Promise<Baked | null> {
    const [a, b] = sourceRange(v, tb, src.sampleRate, s);
    const data = await src.read(a, b);
    return { sample: s.sample, frames: s.frames, data: bakeSlice(v, tb, src.sampleRate, data, a, s) };
  }
  return (await Promise.all(jobs)).filter((x): x is Baked => x !== null);
}

/**
 * Sum overlapping slices into the program mix: one stereo block per absolute slice boundary inside `[from, to)`,
 * so concurrent voices cost one node, not N. Blocks are trimmed to the window and silent ones are dropped.
 */
export function mixToBlocks(slices: Baked[], from: number, to: number): Baked[] {
  const blocks = new Map<number, Baked>();
  for (const s of slices) {
    for (let b = Math.floor(s.sample / SLICE_SAMPLES); b * SLICE_SAMPLES < s.sample + s.frames; b++) {
      const bs = Math.max(b * SLICE_SAMPLES, from);
      const be = Math.min((b + 1) * SLICE_SAMPLES, to);
      if (be <= bs) continue;
      let blk = blocks.get(b);
      if (!blk) {
        blk = { sample: bs, frames: be - bs, data: [new Float32Array(be - bs), new Float32Array(be - bs)] };
        blocks.set(b, blk);
      }
      const lo = Math.max(bs, s.sample);
      const hi = Math.min(be, s.sample + s.frames);
      for (let i = lo; i < hi; i++) {
        blk.data[0][i - bs]! += s.data[0][i - s.sample]!;
        blk.data[1][i - bs]! += s.data[1][i - s.sample]!;
      }
    }
  }
  return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}
