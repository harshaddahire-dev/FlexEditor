import { type Sequence, frameTicks, sequenceDuration } from '@cutroom/core';
import { audio } from '../audio/engine';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';

type TL = ReturnType<typeof useTimeline.getState>;

/**
 * Playback clock. At 1× forward the audio device is the master clock — the playhead is derived from what is being
 * heard, snapped down to a whole frame — so picture can never drift from sound. Shuttle speeds and reverse have no
 * audio and fall back to a frame-quantised wall clock. Honours the in/out range and loop either way.
 */
export function startTransport(): () => void {
  let raf = 0;
  let last = 0;
  let carry = 0;
  /** Playhead value this clock last wrote; anything else is a seek made by the user. */
  let committed: number | null = null;

  const bounds = (seq: Sequence, tl: TL) => ({ start: tl.inPoint ?? 0, end: tl.outPoint ?? sequenceDuration(seq) });

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const tl = useTimeline.getState();
    const seq = useApp.getState().sequence;
    if (!tl.playing || !seq) {
      if (audio.running || audio.starting) audio.stop();
      last = 0;
      carry = 0;
      committed = null;
      return;
    }
    if (tl.shuttle === 1) {
      last = 0;
      carry = 0;
      audioClocked(seq, tl);
      return;
    }
    if (audio.running || audio.starting) audio.stop();
    committed = null;
    if (!last) last = now;
    const dt = (now - last) / 1000;
    last = now;
    wallClocked(seq, tl, dt);
  };

  function audioClocked(seq: Sequence, tl: TL): void {
    const { start, end } = bounds(seq, tl);
    if (committed !== null && tl.playhead !== committed) {
      // the user moved the playhead: resume from there
      committed = tl.playhead;
      void audio.start(tl.playhead, end);
      return;
    }
    if (!audio.running) {
      if (!audio.starting) {
        committed = tl.playhead;
        if (tl.playhead >= end) {
          tl.setPlaying(false);
          return;
        }
        void audio.start(tl.playhead, end).then(() => audio.error && tl.say(audio.error));
      }
      return;
    }
    const f = frameTicks(seq.timebase);
    const next = Math.floor(audio.position() / f) * f;
    if (next >= end) {
      if (tl.loop && end > start) {
        tl.setPlayhead(start, seq);
        committed = useTimeline.getState().playhead;
        void audio.start(start, end);
      } else {
        audio.stop();
        tl.setPlayhead(end, seq);
        tl.setPlaying(false);
      }
      return;
    }
    if (next !== committed) {
      tl.setPlayhead(next, seq);
      committed = useTimeline.getState().playhead;
    }
  }

  function wallClocked(seq: Sequence, tl: TL, dt: number): void {
    const f = frameTicks(seq.timebase);
    carry += dt * tl.shuttle * seq.timebase.rate;
    const whole = Math.trunc(carry / f);
    if (whole === 0) return;
    carry -= whole * f;
    const { start, end } = bounds(seq, tl);
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

  // An edit (or mute/solo/gain change) while playing: re-plan the audio from where we are.
  let prevSeq = useApp.getState().sequence;
  let prevMedia = useApp.getState().media;
  const unsub = useApp.subscribe((s) => {
    if (s.sequence === prevSeq && s.media === prevMedia) return;
    const mediaOnly = s.sequence === prevSeq;
    prevSeq = s.sequence;
    prevMedia = s.media;
    const tl = useTimeline.getState();
    if (!tl.playing || tl.shuttle !== 1 || !s.sequence || !(audio.running || audio.starting)) return;
    if (mediaOnly && audio.running) return; // job progress etc.: nothing audible changed
    const end = bounds(s.sequence, tl).end;
    void audio.start(Math.floor(audio.position()), end);
  });

  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    unsub();
    audio.stop();
  };
}
