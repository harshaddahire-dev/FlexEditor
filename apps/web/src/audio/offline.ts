import { type Media, type Sequence, planAudio } from '@cutroom/core';
import { bakeWindow, mixToBlocks, openSources } from './scheduler';
import { envOf } from './sources';

/**
 * Render the program audio for timeline samples `[from, to)` through an OfflineAudioContext. The graph is the live
 * one — baked slices → buffer sources → master — and the slices are pure functions of the sequence, so this is the
 * playback mix, sample for sample. (Export renders long programs as consecutive windows of this.)
 */
export async function renderProgramAudio(seq: Sequence, media: Record<string, Media>, from: number, to: number): Promise<AudioBuffer> {
  const sr = seq.timebase.sampleRate;
  const voices = planAudio(seq, envOf(media, seq));
  const sources = await openSources(voices, media);
  const blocks = mixToBlocks(await bakeWindow(seq, voices, sources, from, to), from, to);
  const ctx = new OfflineAudioContext(2, Math.max(1, to - from), sr);
  const master = ctx.createGain();
  master.connect(ctx.destination);
  for (const blk of blocks) {
    const buf = ctx.createBuffer(2, blk.frames, sr);
    buf.copyToChannel(blk.data[0], 0);
    buf.copyToChannel(blk.data[1], 1);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(master);
    node.start((blk.sample - from) / sr);
  }
  return ctx.startRendering();
}
