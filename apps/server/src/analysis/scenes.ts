import type { Rational } from '@cutroom/core';
import { runText } from '../proc';

export interface SceneCut {
  /** Frame index of the first frame of the new shot, at the proxy frame rate. */
  frame: number;
  /** Seconds. */
  time: number;
}

/**
 * Shot boundaries via ffmpeg's scene score on the (constant-frame-rate) video proxy. Frame indices are exact because
 * the proxy is CFR; a score threshold of ~0.3 catches hard cuts without firing on camera motion.
 */
export async function detectScenes(ffmpeg: string, proxy: string, fps: Rational, opts: { threshold?: number; signal?: AbortSignal } = {}): Promise<SceneCut[]> {
  const t = opts.threshold ?? 0.3;
  const r = await runText(ffmpeg, ['-hide_banner', '-nostdin', '-i', proxy, '-an', '-vf', `select='gt(scene,${t})',showinfo`, '-f', 'null', '-'], { signal: opts.signal });
  if (r.code !== 0) throw new Error(`scene detection failed: ${r.stderr.trim().split('\n').pop() ?? ''}`);
  const cuts: SceneCut[] = [];
  const rate = fps.num / fps.den;
  for (const line of r.stderr.split('\n')) {
    if (!line.includes('Parsed_showinfo')) continue;
    const m = /pts_time:([\d.]+)/.exec(line);
    if (!m) continue;
    const time = Number(m[1]);
    const frame = Math.round(time * rate);
    if (frame > 0 && cuts.at(-1)?.frame !== frame) cuts.push({ frame, time: frame / rate });
  }
  return cuts;
}
