import { useApp } from '../store/app';
import { detectOnsets } from './analyze';
import { renderProgramAudio } from './offline';
import { audio } from './engine';

/** Dev-only handles for the Playwright specs (never part of a production build). */
export const audioHook = {
  engine: audio,
  /** Render the whole program offline and return where the 1 kHz beeps start, in timeline seconds. */
  async renderOnsets(): Promise<{ onsets: number[]; peak: number; samples: number }> {
    const { sequence: seq, media } = useApp.getState();
    if (!seq) throw new Error('No sequence.');
    const S = seq.timebase.rate / seq.timebase.sampleRate;
    const end = Math.max(0, ...seq.tracks.flatMap((t) => Object.values(t.items).map((i) => i.start + i.duration)));
    const buf = await renderProgramAudio(seq, media, 0, Math.ceil(end / S));
    const ch = buf.getChannelData(0);
    let peak = 0;
    for (const x of ch) peak = Math.max(peak, Math.abs(x));
    const onsets = detectOnsets(ch, 0.05, 4800).map((i) => i / buf.sampleRate);
    return { onsets, peak, samples: ch.length };
  },
};
