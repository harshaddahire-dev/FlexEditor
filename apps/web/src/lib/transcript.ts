import { type Sequence, frameTicks, isClip, trackItems } from '@cutroom/core';

/** Timeline position (ticks, on the frame grid) where media time `srcTicks` is on screen, or null if it is not used. */
export function timelineTimeForSource(seq: Sequence, mediaId: string, srcTicks: number): number | null {
  const f = frameTicks(seq.timebase);
  let best: number | null = null;
  for (const track of seq.tracks) {
    for (const item of trackItems(track)) {
      if (!isClip(item) || item.mediaId !== mediaId) continue;
      const speed = item.speed.num / item.speed.den;
      const span = item.duration * speed;
      if (srcTicks < item.sourceIn || srcTicks >= item.sourceIn + span) continue;
      const t = Math.round((item.start + (srcTicks - item.sourceIn) / speed) / f) * f;
      if (best === null || t < best) best = t;
    }
  }
  return best;
}

/** `m:ss.t` — transcript timestamps. */
export function formatStamp(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Case-insensitive filter that keeps whole segments containing every search term. */
export function filterSegments<T extends { text: string }>(segments: readonly T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? segments.filter((s) => terms.every((t) => s.text.toLowerCase().includes(t))) : [...segments];
}
