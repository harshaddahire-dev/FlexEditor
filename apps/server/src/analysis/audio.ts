import fs from 'node:fs/promises';
import { BeatAnalyzer, type BeatResult, LoudnessMeter, type LoudnessResult, PeakBuilder, type SampleRange, SilenceDetector, parseWavHeader } from '@cutroom/core';
import { ProcessAbortedError } from '../proc';

export const PEAK_BIN = 256;

export interface AudioAnalysis {
  sampleRate: number;
  frames: number;
  waveform: { samplesPerBin: number; peaks: Int16Array };
  silences: SampleRange[];
  loudness: LoudnessResult;
  beats: BeatResult;
}

export interface AnalyzeOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  silence?: { thresholdDb?: number; minSeconds?: number };
}

/**
 * One pass over the 48 kHz PCM proxy feeds every audio analyser: waveform peaks, silence ranges, BS.1770 loudness and
 * beat tracking. Reading the proxy (not the original) means decoding cost is paid once, at proxy time.
 */
export async function analyzeWav(file: string, opts: AnalyzeOptions = {}): Promise<AudioAnalysis> {
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const info = parseWavHeader(head.buffer.slice(head.byteOffset, head.byteOffset + bytesRead));
    const { channels, sampleRate, dataOffset, frames } = info;

    const peaks = new PeakBuilder(PEAK_BIN);
    const silence = new SilenceDetector({ sampleRate, ...opts.silence });
    const loudness = new LoudnessMeter(sampleRate, Math.min(2, channels));
    const beats = new BeatAnalyzer(sampleRate);

    const CHUNK_FRAMES = 48_000;
    const buf = Buffer.alloc(CHUNK_FRAMES * channels * 2);
    for (let done = 0; done < frames; ) {
      if (opts.signal?.aborted) throw new ProcessAbortedError();
      const want = Math.min(CHUNK_FRAMES, frames - done);
      const { bytesRead: got } = await fh.read(buf, 0, want * channels * 2, dataOffset + done * channels * 2);
      const n = Math.floor(got / (channels * 2));
      if (n === 0) break;
      const chans = Array.from({ length: channels }, () => new Float32Array(n));
      for (let f = 0; f < n; f++) for (let c = 0; c < channels; c++) chans[c]![f] = buf.readInt16LE((f * channels + c) * 2) / 32768;
      const stereo = chans.slice(0, 2);
      peaks.push(chans);
      silence.push(chans);
      loudness.push(stereo);
      const mono = channels === 1 ? chans[0]! : chans[0]!.map((v, i) => (v + chans[1]![i]!) / 2);
      beats.push(mono);
      done += n;
      opts.onProgress?.(done / frames);
    }
    return {
      sampleRate,
      frames,
      waveform: { samplesPerBin: PEAK_BIN, peaks: peaks.finish() },
      silences: silence.finish(),
      loudness: loudness.result(),
      beats: beats.finish(),
    };
  } finally {
    await fh.close();
  }
}
