import { type ExportInfo, type ExportPreset, type ExportRequest, type Media, type Sequence, exportPreset, frameTicks } from '@cutroom/core';
import { renderProgramAudio } from '../audio/offline';
import { api } from '../lib/api';
import { Compositor } from '../playback/compositor';
import { FrameBuilder } from '../playback/frameBuilder';
import { probeDecodable } from '../playback/videoSource';
import { mediaUrl } from '../lib/api';
import { avcCodecFor, bitrateFor, interleave, ivfFrame, ivfHeader, wavHeader } from './wav';

export interface ExportCallbacks {
  onInfo?(info: ExportInfo): void;
  /** 0..1 across the whole export (audio first, then picture, then mux on the server). */
  onProgress?(fraction: number, label: string): void;
}

export class ExportCanceled extends Error {
  constructor() {
    super('Export canceled.');
    this.name = 'ExportCanceled';
  }
}

const AUDIO_WINDOW_SECONDS = 30;
const UPLOAD_CHUNK = 4 * 1024 * 1024;

async function put(url: string, body: BodyInit, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body, signal });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(j.message ?? `Upload failed (${res.status}).`);
  }
}

/** Which engine can make this export here, and why not WebCodecs when it cannot. */
export async function chooseEngine(preset: ExportPreset, seq: Sequence, media: Record<string, Media>, draft: boolean): Promise<{ engine: 'webcodecs' | 'ffmpeg'; reason?: string }> {
  if (!preset.video) return { engine: 'ffmpeg' };
  if (!preset.webcodecs) return { engine: 'ffmpeg', reason: `${preset.label} is encoded by FFmpeg.` };
  if (typeof VideoEncoder === 'undefined') return { engine: 'ffmpeg', reason: 'This browser cannot encode video (no WebCodecs).' };
  const used = new Set<string>();
  for (const t of seq.tracks) if (t.kind === 'video' && !t.muted) for (const i of Object.values(t.items)) if (i.kind === 'clip' && i.enabled) used.add(i.mediaId);
  for (const id of used) {
    const m = media[id];
    if (!m || m.type !== 'video') continue;
    if (draft) {
      if (m.status.proxy !== 'done') return { engine: 'ffmpeg', reason: `The proxy of ${m.name} is not ready.` };
      continue;
    }
    const r = await probeDecodable(mediaUrl(m.id, 'original', m.mtimeMs));
    if (!r.ok) return { engine: 'ffmpeg', reason: `${m.name}: ${r.reason}. FFmpeg renders from the original instead.` };
  }
  return { engine: 'webcodecs' };
}

/** Mix the program audio exactly as playback does (same slices, same graph) and stream it to the server as a WAV. */
async function uploadAudio(id: string, seq: Sequence, media: Record<string, Media>, from: number, to: number, signal: AbortSignal, progress: (f: number) => void): Promise<void> {
  const sr = seq.timebase.sampleRate;
  const samplesOf = (ticks: number) => Math.round((ticks * sr) / seq.timebase.rate);
  const a = samplesOf(from);
  const b = samplesOf(to);
  const total = Math.max(1, b - a);
  const win = AUDIO_WINDOW_SECONDS * sr;
  let part = 0;
  let pos = a;
  const send = async (bytes: Uint8Array[], last: boolean) => {
    const blob = new Blob(bytes as BlobPart[]);
    await put(`/api/exports/${id}/audio?part=${part++}&last=${last ? 1 : 0}`, blob, signal);
  };
  await send([wavHeader(total, sr)], false);
  while (pos < b) {
    if (signal.aborted) throw new ExportCanceled();
    const end = Math.min(b, pos + win);
    const buf = await renderProgramAudio(seq, media, pos, end);
    pos = end;
    progress((pos - a) / total);
    await send([interleave(buf)], pos >= b);
  }
}

class VideoUploader {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly id: string,
    private readonly format: 'h264' | 'ivf',
    private readonly signal: AbortSignal,
  ) {}

  push(data: Uint8Array): void {
    this.chunks.push(data);
    this.size += data.byteLength;
    if (this.size >= UPLOAD_CHUNK) this.flushNow();
  }

  private flushNow(): void {
    if (!this.chunks.length) return;
    const blob = new Blob(this.chunks as BlobPart[]);
    this.chunks = [];
    this.size = 0;
    // one request at a time, in order: the server appends
    this.chain = this.chain.then(() => put(`/api/exports/${this.id}/video?format=${this.format}`, blob, this.signal));
  }

  /** Resolves when everything pushed so far is on the server; rejects if any upload failed. */
  async drain(): Promise<void> {
    this.flushNow();
    await this.chain;
  }

  get backlog(): Promise<void> {
    return this.chain;
  }
}

async function renderVideo(id: string, req: ExportRequest, preset: ExportPreset, seq: Sequence, media: Record<string, Media>, from: number, to: number, signal: AbortSignal, progress: (f: number) => void): Promise<number> {
  const W = req.width ?? seq.width;
  const H = req.height ?? seq.height;
  const fps = seq.timebase.fps.num / seq.timebase.fps.den;
  const step = frameTicks(seq.timebase);
  const frames = Math.round((to - from) / step);
  const scaled = W !== seq.width || H !== seq.height;

  const comp = new Compositor(seq.width, seq.height);
  const out = scaled ? document.createElement('canvas') : null;
  if (out) {
    out.width = W;
    out.height = H;
  }
  const out2d = out?.getContext('2d') ?? null;
  const builder = new FrameBuilder(req.draft ? 'proxy' : 'original');
  const format = preset.video === 'h264' ? 'h264' : 'ivf';
  const uploader = new VideoUploader(id, format, signal);

  const cfg: VideoEncoderConfig = {
    codec: preset.video === 'h264' ? avcCodecFor(W, H, fps) : 'vp09.00.40.08',
    width: W,
    height: H,
    bitrate: bitrateFor(preset.bitrate1080, W, H, fps),
    framerate: fps,
    latencyMode: 'quality',
    ...(preset.video === 'h264' ? { avc: { format: 'annexb' as const } } : {}),
  };
  const sup = await VideoEncoder.isConfigSupported(cfg);
  if (!sup.supported) throw new Error(`This browser cannot encode ${cfg.codec} at ${W}×${H}.`);

  let encoderError: Error | null = null;
  let produced = 0;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      uploader.push(format === 'ivf' ? ivfFrame(data, produced) : data);
      produced++;
    },
    error: (e) => (encoderError = e instanceof Error ? e : new Error(String(e))),
  });
  encoder.configure(cfg);
  if (format === 'ivf') uploader.push(ivfHeader(W, H, seq.timebase.fps.num, seq.timebase.fps.den));

  const gop = Math.max(1, Math.round(fps * 2));
  let lastReport = 0;
  try {
    for (let n = 0; n < frames; n++) {
      if (signal.aborted) throw new ExportCanceled();
      if (encoderError) throw encoderError;
      const ticks = from + n * step;
      const built = await builder.build(ticks, seq, media);
      if (built.waiting) throw new Error(`Could not read a source file at ${(ticks / seq.timebase.rate).toFixed(2)} s.`);
      comp.render(built.items);
      let src: HTMLCanvasElement = comp.canvas;
      if (out && out2d) {
        out2d.imageSmoothingQuality = 'high';
        out2d.clearRect(0, 0, W, H);
        out2d.drawImage(comp.canvas, 0, 0, W, H);
        src = out;
      }
      const frame = new VideoFrame(src, { timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: n % gop === 0 });
      frame.close();
      // backpressure: neither the encoder queue nor the upload may run away from the renderer
      while (encoder.encodeQueueSize > 6) await new Promise<void>((r) => encoder.addEventListener('dequeue', () => r(), { once: true }));
      if (n % 8 === 0) await uploader.backlog;
      const now = performance.now();
      if (now - lastReport > 200) {
        lastReport = now;
        progress((n + 1) / frames);
        void fetch(`/api/exports/${id}/progress`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fraction: (n + 1) / frames }), signal }).catch(() => undefined);
      }
    }
    await encoder.flush();
    if (encoderError) throw encoderError;
    await uploader.drain();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    builder.dispose();
    comp.dispose();
  }
  return frames;
}

/**
 * Run an export end to end. Audio is always rendered here (the playback graph, offline) and uploaded; the picture is
 * either rendered here and encoded with WebCodecs, or left to the server's FFmpeg renderer.
 */
export async function runExport(req: ExportRequest, seq: Sequence, media: Record<string, Media>, from: number, to: number, signal: AbortSignal, cb: ExportCallbacks = {}): Promise<ExportInfo> {
  const preset = exportPreset(req.preset);
  if (!preset) throw new Error(`Unknown preset ${req.preset}.`);
  const hasVideo = !!preset.video;
  const web = hasVideo && req.engine === 'webcodecs';
  // share of the bar: audio 10 %, picture 80 % (browser) or the server's progress (FFmpeg), then mux
  const parts = web ? { audio: 0.1, video: 0.85 } : { audio: 0.05, video: 0 };
  const created = await api.createExport({ ...req, from, to });
  let info = created;
  cb.onInfo?.(info);
  const cancelServer = () => void fetch(`/api/exports/${created.id}`, { method: 'DELETE' }).catch(() => undefined);
  signal.addEventListener('abort', cancelServer, { once: true });
  try {
    cb.onProgress?.(0, 'Mixing audio');
    await uploadAudio(created.id, seq, media, from, to, signal, (f) => cb.onProgress?.(f * parts.audio, 'Mixing audio'));
    if (web) {
      cb.onProgress?.(parts.audio, 'Rendering picture');
      const frames = await renderVideo(created.id, req, preset, seq, media, from, to, signal, (f) => cb.onProgress?.(parts.audio + f * parts.video, 'Rendering picture'));
      const r = await fetch(`/api/exports/${created.id}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ frames }), signal });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { message?: string }).message ?? 'The server rejected the video.');
    }
    // the server muxes (or renders, for FFmpeg) — follow it until it is done
    for (;;) {
      if (signal.aborted) throw new ExportCanceled();
      info = await api.getExport(created.id);
      cb.onInfo?.(info);
      const job = await api.job(info.jobId).catch(() => null);
      if (job) {
        if (job.state === 'failed') throw new Error(job.error ?? 'The export failed.');
        if (job.state === 'canceled') throw new ExportCanceled();
        const base = web ? parts.audio + parts.video : parts.audio;
        cb.onProgress?.(Math.min(0.995, base + job.progress * (1 - base)), info.phase === 'mux' ? 'Finishing' : web ? 'Finishing' : 'Rendering with FFmpeg');
      }
      if (info.phase === 'done' && info.output) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    cb.onProgress?.(1, 'Done');
    return info;
  } catch (e) {
    if (signal.aborted && !(e instanceof ExportCanceled)) throw new ExportCanceled();
    cancelServer();
    throw e;
  }
}
