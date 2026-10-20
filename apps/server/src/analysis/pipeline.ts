import fs from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisState, Media } from '@cutroom/core';
import type { JobQueue } from '../jobs';
import { ProcessAbortedError } from '../proc';
import { renameRetry } from '../util';
import { analyzeWav } from './audio';
import { generateFilmstrip, planFilmstrip } from './filmstrip';
import { detectScenes } from './scenes';
import { type WhisperInstall, transcribe } from './whisper';

/** What the pipeline needs from the project manager. */
export interface AnalysisHost {
  jobs: JobQueue;
  ffmpegPath: string;
  /** Absolute cache directory of one media item (created on demand). */
  cacheDir(mediaId: string): string;
  /** Absolute path of a stored (project-relative or absolute) path. */
  abs(stored: string): string;
  find(id: string): Media | undefined;
  patch(id: string, mutate: (m: Media) => void): Media | undefined;
  whisper(): Promise<WhisperInstall | null>;
}

type Key = keyof Media['status'];
const AUDIO_KEYS = ['waveform', 'silences', 'loudness', 'beats'] as const satisfies readonly Key[];
const VIDEO_KEYS = ['filmstrip', 'scenes'] as const satisfies readonly Key[];

/** Files that must exist for a stage to count as done. */
export const CACHE_FILES: Record<string, string[]> = {
  waveform: ['waveform.json', 'waveform.bin'],
  silences: ['silences.json'],
  loudness: ['loudness.json'],
  beats: ['beats.json'],
  filmstrip: ['filmstrip.json', 'filmstrip.jpg'],
  scenes: ['scenes.json'],
  transcript: ['transcript.json'],
};

/** Files the HTTP API may serve from a media item's cache, with their content types. */
export const SERVABLE: Record<string, { file: string; type: string }> = {
  waveform: { file: 'waveform.json', type: 'application/json' },
  'waveform.bin': { file: 'waveform.bin', type: 'application/octet-stream' },
  silences: { file: 'silences.json', type: 'application/json' },
  loudness: { file: 'loudness.json', type: 'application/json' },
  beats: { file: 'beats.json', type: 'application/json' },
  scenes: { file: 'scenes.json', type: 'application/json' },
  filmstrip: { file: 'filmstrip.json', type: 'application/json' },
  'filmstrip.jpg': { file: 'filmstrip.jpg', type: 'image/jpeg' },
  transcript: { file: 'transcript.json', type: 'application/json' },
};

const finite = (x: number): number | null => (Number.isFinite(x) ? x : null);

async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await renameRetry(tmp, file);
}

/**
 * Media intelligence. For every imported file, queues the analyses it is due — waveform / silences / loudness / beats
 * (one pass over the PCM proxy), filmstrip and scene cuts (video proxy) and a whisper.cpp transcript when the tool is
 * installed — and records results as small JSON/binary files in the cache with a short summary in `media.analysis`
 * (what the agents and the UI read without fetching the whole thing).
 */
export class MediaAnalysis {
  constructor(private readonly host: AnalysisHost) {}

  /** Queue whatever is due. Safe to call repeatedly; also repairs stages whose cache files have gone missing. */
  async ensure(id: string): Promise<void> {
    let m = this.host.find(id);
    if (!m || m.missing) return;
    const dir = this.host.cacheDir(id);

    // stages marked done whose files were deleted go back to pending
    for (const [key, files] of Object.entries(CACHE_FILES)) {
      const state = m.status[key as Key];
      if (state !== 'done') continue;
      const present = await Promise.all(files.map((f) => fs.access(path.join(dir, f)).then(() => true, () => false)));
      if (present.some((p) => !p)) this.host.patch(id, (x) => void (x.status[key as Key] = 'pending'));
    }
    m = this.host.find(id)!;

    const hasAudio = !!m.audio && !!m.audioProxyPath;
    const hasVideo = m.type === 'video' && !!m.proxyPath;
    // stages that cannot apply to this kind of media are not "pending", they are not needed
    this.host.patch(id, (x) => {
      if (!x.audio) for (const k of [...AUDIO_KEYS, 'transcript'] as const) x.status[k] = 'skipped';
      if (x.type !== 'video') for (const k of VIDEO_KEYS) x.status[k] = 'skipped';
    });
    m = this.host.find(id)!;

    if (hasAudio && AUDIO_KEYS.some((k) => m!.status[k] === 'pending')) this.queueAudio(id);
    if (hasVideo && VIDEO_KEYS.some((k) => m!.status[k] === 'pending')) this.queueVideo(id);
    if (hasAudio && (m.status.transcript === 'pending' || m.status.transcript === 'unavailable')) await this.queueTranscript(id);
  }

  /** Put failed/unavailable stages back to pending (e.g. after installing whisper.cpp) and run them again. */
  async retry(id: string): Promise<void> {
    this.host.patch(id, (x) => {
      for (const k of Object.keys(CACHE_FILES) as Key[]) if (x.status[k] === 'failed' || x.status[k] === 'unavailable') x.status[k] = 'pending';
    });
    await this.ensure(id);
  }

  private set(id: string, keys: readonly Key[], state: AnalysisState): void {
    this.host.patch(id, (m) => void keys.forEach((k) => (m.status[k] = state)));
  }

  private fail(id: string, keys: readonly Key[], e: unknown, what: string): void {
    const aborted = e instanceof ProcessAbortedError;
    this.host.patch(id, (m) => {
      for (const k of keys) m.status[k] = aborted ? 'pending' : 'failed';
      if (!aborted) m.warnings.push(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private queueAudio(id: string): void {
    this.set(id, AUDIO_KEYS, 'queued');
    this.host.jobs.add({
      kind: 'analysis',
      label: `Waveform & levels · ${this.host.find(id)?.name ?? id}`,
      mediaId: id,
      run: async ({ signal, progress }) => {
        const m = this.host.find(id);
        if (!m?.audioProxyPath) return this.set(id, AUDIO_KEYS, 'pending');
        this.set(id, AUDIO_KEYS, 'running');
        try {
          const a = await analyzeWav(this.host.abs(m.audioProxyPath), { signal, onProgress: progress });
          const dir = this.host.cacheDir(id);
          await fs.mkdir(dir, { recursive: true });
          const sr = a.sampleRate;
          const peaks = Buffer.from(a.waveform.peaks.buffer, a.waveform.peaks.byteOffset, a.waveform.peaks.byteLength);
          await writeAtomic(path.join(dir, 'waveform.bin'), peaks);
          await writeAtomic(path.join(dir, 'waveform.json'), JSON.stringify({ samplesPerBin: a.waveform.samplesPerBin, sampleRate: sr, bins: a.waveform.peaks.length / 2, frames: a.frames }));
          await writeAtomic(path.join(dir, 'silences.json'), JSON.stringify({ sampleRate: sr, thresholdDb: -40, minSeconds: 0.3, ranges: a.silences }));
          const l = a.loudness;
          const loud = { integrated: finite(l.integrated), range: l.range, truePeak: finite(l.truePeak), momentaryMax: finite(l.momentaryMax), shortTermMax: finite(l.shortTermMax), duration: l.duration };
          await writeAtomic(path.join(dir, 'loudness.json'), JSON.stringify(loud));
          await writeAtomic(path.join(dir, 'beats.json'), JSON.stringify(a.beats));
          this.host.patch(id, (x) => {
            x.analysis.waveform = { bins: a.waveform.peaks.length / 2, samplesPerBin: a.waveform.samplesPerBin, sampleRate: sr };
            x.analysis.silences = { count: a.silences.length, totalSeconds: a.silences.reduce((s, r) => s + (r.end - r.start) / sr, 0) };
            x.analysis.loudness = loud;
            x.analysis.beats = { bpm: a.beats.bpm, confidence: a.beats.confidence, count: a.beats.beats.length };
            for (const k of AUDIO_KEYS) x.status[k] = 'done';
          });
        } catch (e) {
          this.fail(id, AUDIO_KEYS, e, 'Audio analysis');
          if (!(e instanceof ProcessAbortedError)) throw e;
        }
      },
    });
  }

  private queueVideo(id: string): void {
    this.set(id, VIDEO_KEYS, 'queued');
    this.host.jobs.add({
      kind: 'analysis',
      label: `Filmstrip & scenes · ${this.host.find(id)?.name ?? id}`,
      mediaId: id,
      run: async ({ signal }) => {
        const m = this.host.find(id);
        if (!m?.proxyPath || !m.proxy) return this.set(id, VIDEO_KEYS, 'pending');
        this.set(id, VIDEO_KEYS, 'running');
        try {
          const proxy = this.host.abs(m.proxyPath);
          const dir = this.host.cacheDir(id);
          await fs.mkdir(dir, { recursive: true });
          const plan = planFilmstrip(m.duration, m.proxy.width, m.proxy.height);
          const tmp = path.join(dir, `filmstrip.${process.pid}.tmp.jpg`);
          await generateFilmstrip(this.host.ffmpegPath, proxy, tmp, plan, signal);
          await renameRetry(tmp, path.join(dir, 'filmstrip.jpg'));
          await writeAtomic(path.join(dir, 'filmstrip.json'), JSON.stringify(plan));
          const cuts = await detectScenes(this.host.ffmpegPath, proxy, m.proxy.fps, { signal });
          await writeAtomic(path.join(dir, 'scenes.json'), JSON.stringify({ fps: m.proxy.fps, cuts }));
          this.host.patch(id, (x) => {
            x.analysis.filmstrip = plan;
            x.analysis.scenes = { count: cuts.length };
            for (const k of VIDEO_KEYS) x.status[k] = 'done';
          });
        } catch (e) {
          this.fail(id, VIDEO_KEYS, e, 'Filmstrip/scene analysis');
          if (!(e instanceof ProcessAbortedError)) throw e;
        }
      },
    });
  }

  private async queueTranscript(id: string): Promise<void> {
    const install = await this.host.whisper();
    if (!install) {
      this.host.patch(id, (x) => {
        x.status.transcript = 'unavailable';
        x.analysis.transcript = { reason: 'whisper.cpp or a ggml model was not found — set WHISPER_CPP_BIN and WHISPER_MODEL, or put ggml-*.bin in the app data "models" folder.' };
      });
      return;
    }
    this.set(id, ['transcript'], 'queued');
    this.host.jobs.add({
      kind: 'analysis',
      label: `Transcript · ${this.host.find(id)?.name ?? id}`,
      mediaId: id,
      run: async ({ signal }) => {
        const m = this.host.find(id);
        if (!m?.audioProxyPath) return this.set(id, ['transcript'], 'pending');
        this.set(id, ['transcript'], 'running');
        try {
          const t = await transcribe(install, this.host.ffmpegPath, this.host.abs(m.audioProxyPath), { signal });
          const dir = this.host.cacheDir(id);
          await fs.mkdir(dir, { recursive: true });
          await writeAtomic(path.join(dir, 'transcript.json'), JSON.stringify(t));
          this.host.patch(id, (x) => {
            x.analysis.transcript = { language: t.language, model: t.model, words: t.words.length, segments: t.segments.length, text: t.segments.map((s) => s.text).join(' ').slice(0, 400) };
            x.status.transcript = 'done';
          });
        } catch (e) {
          this.fail(id, ['transcript'], e, 'Transcription');
          if (!(e instanceof ProcessAbortedError)) throw e;
        }
      },
    });
  }
}

