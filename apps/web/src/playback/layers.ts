import { type Clip, type Sequence, type Transform, evaluateKeyframes, isClip, trackItems } from '@cutroom/core';

/** Affine map from the unit square of a source frame to sequence pixels: x = a·u + c·v + e, y = b·u + d·v + f. */
export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

/**
 * Where a layer's source frame lands in the sequence. The source is first fitted ("contain") into the sequence
 * frame, then the clip transform is applied about its anchor: scale, rotate (clockwise, degrees), then translate
 * from the frame centre. Pure, so it is unit-tested without a GL context.
 */
export function layerMatrix(t: Transform, srcW: number, srcH: number, seqW: number, seqH: number): Affine {
  const fit = Math.min(seqW / srcW, seqH / srcH);
  const w = srcW * fit * t.scale.x;
  const h = srcH * fit * t.scale.y;
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // p = centre + position + R · ((u - ax)·w, (v - ay)·h)
  const a = cos * w;
  const b = sin * w;
  const c = -sin * h;
  const d = cos * h;
  const e = seqW / 2 + t.position.x - (a * t.anchor.x + c * t.anchor.y);
  const f = seqH / 2 + t.position.y - (b * t.anchor.x + d * t.anchor.y);
  return [a, b, c, d, e, f];
}

export const applyAffine = (m: Affine, u: number, v: number): [number, number] => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];

/** Clip transform with its keyframes evaluated at `rel` ticks from the clip start. */
export function resolveTransform(clip: Clip, rel: number): Transform {
  const base = clip.transform;
  const kf = clip.keyframes;
  const at = (path: string, fallback: number): number => {
    const k = kf[path];
    return k && k.length ? evaluateKeyframes(k, rel, fallback) : fallback;
  };
  return {
    position: { x: at('position.x', base.position.x), y: at('position.y', base.position.y) },
    scale: { x: at('scale.x', base.scale.x), y: at('scale.y', base.scale.y) },
    rotation: at('rotation', base.rotation),
    anchor: { x: at('anchor.x', base.anchor.x), y: at('anchor.y', base.anchor.y) },
    opacity: Math.max(0, Math.min(1, at('opacity', base.opacity))),
    crop: {
      left: at('crop.left', base.crop.left),
      right: at('crop.right', base.crop.right),
      top: at('crop.top', base.crop.top),
      bottom: at('crop.bottom', base.crop.bottom),
    },
  };
}

/** Media time (sequence ticks) shown at timeline time `ticks`. Integer arithmetic; rational speed floors. */
export function sourceTicksAt(clip: Clip, ticks: number): number {
  const rel = ticks - clip.start;
  return clip.sourceIn + Math.floor((rel * clip.speed.num) / clip.speed.den);
}

export interface ActiveLayer {
  clip: Clip;
  /** Index of the video track in the sequence (0 = bottom of the stack). */
  order: number;
}

/** Enabled video clips under the playhead, bottom of the stack first. Cuts are half-open: [start, end). */
export function activeVideoClips(seq: Sequence, ticks: number): ActiveLayer[] {
  const out: ActiveLayer[] = [];
  let order = 0;
  for (const track of seq.tracks) {
    if (track.kind !== 'video' || track.muted) continue; // a hidden video track is not rendered
    for (const item of trackItems(track)) {
      if (!isClip(item) || !item.enabled) continue;
      if (item.start > ticks) break;
      if (ticks < item.start + item.duration) out.push({ clip: item, order });
    }
    order++;
  }
  return out;
}
