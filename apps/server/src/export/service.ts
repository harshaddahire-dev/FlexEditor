import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { type CaptionItem, type ExportInfo, type ExportPreset, type ExportRequest, type JobInfo, type Media, type Sequence, captionsToSubtitles, exportPreset, exportRange, frameTicks, isCaption, itemEnd, safeFileStem, sequenceDuration, trackItems } from '@cutroom/core';
import type { JobQueue } from '../jobs';
import { fromStoredPath } from '../paths';
import { runText } from '../proc';
import { buildAss } from './ass';
import { muxWebCodecs, renderWithFfmpeg, writeAudioOnly } from './render';
import { buildVideoGraph } from './video';

export class ExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface ExportProject {
  folder(): string | null;
  sequence(): Sequence;
  media(): Media[];
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(e: Error): void;
}
const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => undefined); // rejections are observed where awaited
  return { promise, resolve, reject };
};

interface Session {
  info: ExportInfo;
  dir: string;
  preset: ExportPreset;
  from: number;
  to: number;
  abort: AbortController;
  audio: Deferred;
  video: Deferred;
  audioPath?: string;
  videoPath?: string;
  videoFormat?: 'h264' | 'ivf';
  frames?: number;
  progress?: (f: number) => void;
  lastProgress: number;
}

const AUDIO_WAIT_MS = 15 * 60_000;

/**
 * Exports. The browser always renders the audio (one graph for playback and export) and uploads it; the picture comes
 * either from the browser (frames from the monitor's compositor, encoded with WebCodecs and streamed here) or from
 * FFmpeg rendering the timeline from the original files. Either way the server does the final mux, writes the
 * sidecars and measures what it made.
 */
export class ExportService {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly project: ExportProject,
    private readonly jobs: JobQueue,
    private readonly bins: { ffmpegPath: string; ffprobePath: string },
    private readonly broadcast: (info: ExportInfo) => void,
  ) {}

  list(): ExportInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  get(id: string): ExportInfo {
    return this.session(id).info;
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new ExportError('no_such_export', 'No such export.', 404);
    return s;
  }

  private emit(s: Session): void {
    this.broadcast({ ...s.info });
  }

  create(req: ExportRequest): ExportInfo {
    const folder = this.project.folder();
    if (!folder) throw new ExportError('no_project', 'Open a project first.');
    const preset = exportPreset(req.preset);
    if (!preset) throw new ExportError('bad_preset', `Unknown preset "${req.preset}".`);
    if (req.engine === 'webcodecs' && !preset.webcodecs && preset.video) throw new ExportError('bad_engine', `${preset.label} is rendered with FFmpeg; choose the FFmpeg engine.`);
    const seq = this.project.sequence();
    const fr = frameTicks(seq.timebase);
    const range = exportRange(sequenceDuration(seq), req);
    const from = Math.round(range.from / fr) * fr;
    const to = Math.round(range.to / fr) * fr;
    if (to <= from) throw new ExportError('empty_range', 'There is nothing to export: the timeline is empty or the range has no length.');
    for (const [k, v] of [['width', req.width], ['height', req.height]] as const) if (v !== undefined && (!Number.isInteger(v) || v < 16 || v > 8192 || v % 2)) throw new ExportError('bad_size', `${k} must be an even number between 16 and 8192.`);

    const id = randomUUID().slice(0, 8);
    const dir = path.join(folder, '.cutroom', 'exports', id);
    const info: ExportInfo = { id, jobId: '', request: { ...req, name: safeFileStem(req.name) }, phase: 'waiting', sidecars: [], warnings: [] };
    const s: Session = { info, dir, preset, from, to, abort: new AbortController(), audio: deferred(), video: deferred(), lastProgress: 0 };
    this.sessions.set(id, s);
    const job = this.jobs.add({
      kind: 'export',
      label: `Export · ${info.request.name}.${preset.ext}`,
      run: (ctx) => this.run(s, ctx),
    });
    info.jobId = job.id;
    this.emit(s);
    return { ...info };
  }

  /** Cancel: abort the work and drop the partial files. */
  cancel(id: string): void {
    const s = this.session(id);
    s.abort.abort();
    for (const d of [s.audio, s.video]) d.reject(new Error('canceled'));
    this.jobs.cancel(s.info.jobId);
  }

  /** The audio mix arrives as one or more in-order parts (a long program is rendered in windows); the last one completes it. */
  async receiveAudio(id: string, body: Readable, part = 0, last = true): Promise<void> {
    const s = this.session(id);
    await fs.mkdir(s.dir, { recursive: true });
    s.audioPath = path.join(s.dir, 'audio.wav');
    try {
      await pipeline(body, createWriteStream(s.audioPath, { flags: part === 0 ? 'w' : 'a' }));
    } catch (e) {
      s.audio.reject(e as Error);
      throw e;
    }
    if (last) s.audio.resolve();
  }

  async receiveVideo(id: string, body: Readable, format: 'h264' | 'ivf'): Promise<void> {
    const s = this.session(id);
    await fs.mkdir(s.dir, { recursive: true });
    s.videoFormat = format;
    s.videoPath = path.join(s.dir, `video.${format === 'h264' ? 'h264' : 'ivf'}`);
    // chunks arrive in order, one request at a time
    await pipeline(body, createWriteStream(s.videoPath, { flags: 'a' }));
  }

  finishVideo(id: string, frames: number): void {
    const s = this.session(id);
    if (!Number.isInteger(frames) || frames < 1) throw new ExportError('bad_frames', 'The browser reported no frames.');
    s.frames = frames;
    s.video.resolve();
  }

  progress(id: string, fraction: number): void {
    const s = this.session(id);
    s.lastProgress = Math.max(0, Math.min(1, fraction));
    s.progress?.(s.lastProgress * 0.95);
  }

  fileOf(id: string): string {
    const s = this.session(id);
    if (!s.info.output) throw new ExportError('not_ready', 'This export is not finished yet.', 409);
    return s.info.output;
  }

  /* ---------------------------------------------------------------- */

  private async run(s: Session, ctx: { signal: AbortSignal; progress(f: number): void }): Promise<void> {
    const folder = this.project.folder()!;
    const { info, preset } = s;
    const req = info.request;
    s.progress = ctx.progress;
    ctx.signal.addEventListener('abort', () => s.abort.abort(), { once: true });
    const signal = s.abort.signal;
    const seq = this.project.sequence();
    try {
      await fs.mkdir(s.dir, { recursive: true });
      const outDir = path.join(folder, 'exports');
      await fs.mkdir(outDir, { recursive: true });
      const out = await freshName(outDir, req.name, preset.ext);
      info.output = undefined;

      info.phase = 'audio';
      this.emit(s);
      await this.waitFor(s.audio.promise, signal, 'The browser never sent the audio mix.');
      info.warnings.push(...(req.draft ? ['Rendered from proxies (draft quality).'] : []));

      if (!preset.video) {
        info.phase = 'mux';
        this.emit(s);
        await writeAudioOnly({ ffmpegPath: this.bins.ffmpegPath, audioPath: s.audioPath!, outFile: out, signal });
      } else if (req.engine === 'ffmpeg') {
        info.phase = 'video';
        this.emit(s);
        const media = new Map(this.project.media().map((m) => [m.id, m]));
        const burn = req.captions === 'burn' || req.captions === 'both';
        const assText = burn ? buildAss(seq, s.from, s.to) : null;
        const assPath = assText ? path.join(s.dir, 'captions.ass') : undefined;
        if (assText && assPath) await fs.writeFile(assPath, assText);
        const graph = buildVideoGraph({ seq, media, pathOf: (m) => fromStoredPath(folder, m.path), from: s.from, to: s.to, assPath, pixFmt: preset.video === 'prores' ? 'yuv422p10le' : 'yuv420p' });
        if (process.env.CUTROOM_KEEP_EXPORT) console.log(JSON.stringify(graph.inputs), '\n' + graph.graph);
        info.warnings.push(...graph.warnings);
        const size = req.width && req.height && (req.width !== seq.width || req.height !== seq.height) ? { width: req.width, height: req.height } : undefined;
        await renderWithFfmpeg({ ffmpegPath: this.bins.ffmpegPath, graph, preset, outFile: out, audioPath: s.audioPath, workDir: s.dir, size, onProgress: (f) => ctx.progress(f * 0.97), signal });
      } else {
        info.phase = 'video';
        this.emit(s);
        await this.waitFor(s.video.promise, signal, 'The browser never finished sending the video.', 24 * 3600_000);
        info.phase = 'mux';
        this.emit(s);
        if (!s.videoPath || !s.videoFormat || !s.frames) throw new Error('The browser sent no video.');
        await muxWebCodecs({ ffmpegPath: this.bins.ffmpegPath, preset, videoFile: s.videoPath, videoFormat: s.videoFormat, fpsRational: `${seq.timebase.fps.num}/${seq.timebase.fps.den}`, frames: s.frames, audioPath: s.audioPath, outFile: out, signal });
      }

      info.output = out;
      info.sidecars = await this.writeSidecars(seq, s, out);
      info.result = await this.measure(out);
      info.phase = 'done';
      this.emit(s);
      if (!process.env.CUTROOM_KEEP_EXPORT) await fs.rm(s.dir, { recursive: true, force: true });
    } catch (e) {
      if (!process.env.CUTROOM_KEEP_EXPORT) await fs.rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
      if (info.output) await fs.rm(info.output, { force: true }).catch(() => undefined);
      info.output = undefined;
      this.emit(s);
      throw e;
    }
  }

  private async waitFor(p: Promise<void>, signal: AbortSignal, timeoutMessage: string, ms = AUDIO_WAIT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      p,
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(timeoutMessage)), ms))),
      new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('Export canceled.')), { once: true })),
    ]).finally(() => clearTimeout(timer));
  }

  private async writeSidecars(seq: Sequence, s: Session, out: string): Promise<string[]> {
    const mode = s.info.request.captions;
    if (mode !== 'sidecar' && mode !== 'both') return [];
    const items: CaptionItem[] = [];
    for (const t of seq.tracks) {
      if (t.kind !== 'caption' || t.muted) continue;
      for (const i of trackItems(t)) if (isCaption(i) && itemEnd(i) > s.from && i.start < s.to) items.push(i);
    }
    if (!items.length) {
      s.info.warnings.push('There are no captions on the timeline, so no subtitle files were written.');
      return [];
    }
    // times relative to the exported range, clipped to it
    const shifted = items.map((c) => ({ start: Math.max(c.start, s.from) - s.from, duration: Math.min(itemEnd(c), s.to) - Math.max(c.start, s.from), words: c.words.map((w) => ({ ...w, start: w.start - s.from, end: w.end - s.from })) }));
    const base = out.slice(0, -path.extname(out).length);
    const files: string[] = [];
    for (const fmt of ['srt', 'vtt'] as const) {
      const f = `${base}.${fmt}`;
      await fs.writeFile(f, captionsToSubtitles(shifted, seq.timebase, fmt));
      files.push(f);
    }
    return files;
  }

  /** What the file really is, read back with ffprobe (not what we hoped to make). */
  private async measure(file: string): Promise<NonNullable<ExportInfo['result']>> {
    const st = await fs.stat(file);
    const out = await runText(this.bins.ffprobePath, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-print_format', 'json', file]);
    const j = JSON.parse(out.stdout || '{}') as { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; nb_read_frames?: string }[]; format?: { duration?: string } };
    const v = j.streams?.find((x) => x.codec_type === 'video');
    const a = j.streams?.find((x) => x.codec_type === 'audio');
    return { durationSeconds: Number(j.format?.duration ?? 0), sizeBytes: st.size, ...(v ? { frames: Number(v.nb_read_frames ?? 0), width: v.width, height: v.height, videoCodec: v.codec_name } : {}), ...(a ? { audioCodec: a.codec_name } : {}) };
  }

  /** Drop everything (project closed, server stopping). */
  close(): void {
    for (const s of this.sessions.values()) s.abort.abort();
  }
}

async function freshName(dir: string, stem: string, ext: string): Promise<string> {
  for (let n = 0; ; n++) {
    const f = path.join(dir, `${stem}${n ? ` (${n})` : ''}.${ext}`);
    try {
      await fs.access(f);
    } catch {
      return f;
    }
  }
}

export type { JobInfo };
