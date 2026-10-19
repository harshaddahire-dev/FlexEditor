import { type Sequence, frameTicks, sequenceDuration } from '@cutroom/core';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';

/**
 * Playback clock. Advances the playhead while `playing`, snapped to whole frames, honouring shuttle speed,
 * the in/out range and loop. (Step 3b swaps the time source for the audio clock; the contract stays the same.)
 */
export function startTransport(): () => void {
  let raf = 0;
  let last = 0;
  let carry = 0;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const tl = useTimeline.getState();
    const seq = useApp.getState().sequence;
    if (!tl.playing || !seq) {
      last = 0;
      carry = 0;
      return;
    }
    if (!last) last = now;
    const dt = (now - last) / 1000;
    last = now;
    advance(seq, tl, dt);
  };

  function advance(seq: Sequence, tl: ReturnType<typeof useTimeline.getState>, dt: number): void {
    const f = frameTicks(seq.timebase);
    carry += dt * tl.shuttle * seq.timebase.rate;
    const whole = Math.trunc(carry / f);
    if (whole === 0) return;
    carry -= whole * f;
    const end = tl.outPoint ?? sequenceDuration(seq);
    const start = tl.inPoint ?? 0;
    let next = tl.playhead + whole * f;
    if (tl.shuttle > 0 && next >= end) {
      if (tl.loop && end > start) next = start + ((next - start) % (end - start));
      else {
        tl.setPlayhead(end, seq);
        tl.setPlaying(false);
        return;
      }
    } else if (tl.shuttle < 0 && next <= start) {
      tl.setPlayhead(start, seq);
      tl.setPlaying(false);
      return;
    }
    tl.setPlayhead(next, seq);
  }

  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
