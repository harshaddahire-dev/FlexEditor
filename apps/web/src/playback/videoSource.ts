import { type SampleRec, type VideoTrackInfo, fetchRange, openVideoTrack } from './demux';

/** Which video codecs this browser can decode — reported to the server so proxies are made in a playable format. */
export async function probeProxyCodec(): Promise<'h264' | 'vp9'> {
  if (typeof VideoDecoder === 'undefined') return 'vp9';
  try {
    const r = await VideoDecoder.isConfigSupported({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });
    if (r.supported) return 'h264';
  } catch {
    /* fall through */
  }
  return 'vp9';
}

interface Gop {
  /** Presentation indices covered, ascending. */
  first: number;
  last: number;
  frames: Map<number, VideoFrame>;
}

const MAX_GOPS = 3;
/** Decoded frames held at once are kept under about this many bytes (I420), so long-GOP footage still plays. */
const GOP_CACHE_BYTES = 1.2 * 1024 ** 3;

/**
 * Frame-accurate random access into a proxy. The container is demuxed with mp4box, frames are decoded one GOP at a
 * time with WebCodecs (a short GOP bounds seek latency), and decoded GOPs are cached with LRU eviction so scrubbing
 * back and forth inside a GOP never decodes twice. `frame(i)` returns a VideoFrame owned by the cache: do not close it.
 */
export class VideoSource {
  private decoder: VideoDecoder | null = null;
  private readonly gops = new Map<number, Promise<Gop>>();
  private readonly order: number[] = [];
  /** Decode index of the sync sample that starts each GOP, keyed by decode index of any sample in it. */
  private readonly gopStart: number[];
  private readonly presOf: number[];
  /** How many decoded GOPs stay cached: 3 normally, fewer when a GOP is huge (1 for a 250-frame 1080p GOP). */
  private readonly maxGops: number;

  private constructor(
    readonly info: VideoTrackInfo,
    private readonly url: string,
  ) {
    this.gopStart = new Array<number>(info.samples.length);
    let start = 0;
    for (const s of info.samples) {
      if (s.sync) start = s.index;
      this.gopStart[s.index] = start;
    }
    this.presOf = new Array<number>(info.samples.length);
    info.presentation.forEach((decodeIdx, p) => (this.presOf[decodeIdx] = p));
    let longest = 0;
    let run = 0;
    for (const sm of info.samples) {
      run = sm.sync ? 1 : run + 1;
      longest = Math.max(longest, run);
    }
    this.maxGops = Math.max(1, Math.min(MAX_GOPS, Math.floor(GOP_CACHE_BYTES / Math.max(1, longest * info.width * info.height * 1.5))));
  }

  static async open(url: string): Promise<VideoSource> {
    return new VideoSource(await openVideoTrack(url), url);
  }

  get width(): number {
    return this.info.width;
  }
  get height(): number {
    return this.info.height;
  }
  get frameCount(): number {
    return this.info.samples.length;
  }

  /**
   * Presentation index of the frame shown at media time `ticks` (sequence ticks at `rate`/s): the last frame whose
   * composition time is ≤ that instant. Integer arithmetic, so a flash on frame N is on frame N at every rate.
   */
  indexAtTicks(ticks: number, rate: number): number {
    const { samples, presentation, timescale } = this.info;
    let lo = 0;
    let hi = presentation.length - 1;
    const target = ticks * timescale;
    if (target < samples[presentation[0]!]!.cts * rate) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[presentation[mid]!]!.cts * rate <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Composition time of presentation frame `p`, in seconds. */
  timeOf(p: number): number {
    return this.info.samples[this.info.presentation[p]!]!.cts / this.info.timescale;
  }

  private config(): VideoDecoderConfig {
    return { codec: this.info.codec, codedWidth: this.info.width, codedHeight: this.info.height, ...(this.info.description ? { description: this.info.description } : {}), optimizeForLatency: true };
  }

  private decoderOrNew(): VideoDecoder {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder;
    this.decoder = new VideoDecoder({ output: () => undefined, error: () => undefined });
    return this.decoder;
  }

  /** Decode every frame of the GOP that contains decode index `d`. */
  private decodeGop(startDecode: number): Promise<Gop> {
    const { samples } = this.info;
    let end = startDecode + 1;
    while (end < samples.length && !samples[end]!.sync) end++;
    const run: SampleRec[] = samples.slice(startDecode, end);
    const lo = run[0]!.offset;
    const hi = run[run.length - 1]!.offset + run[run.length - 1]!.size - 1;

    return (async () => {
      const { data } = await fetchRange(this.url, lo, hi);
      const frames = new Map<number, VideoFrame>();
      const byTimestamp = new Map<number, number>(); // timestamp µs → presentation index
      for (const s of run) byTimestamp.set(Math.round((s.cts * 1e6) / this.info.timescale), this.presOf[s.index]!);

      const decoder = new VideoDecoder({
        output: (frame) => {
          const p = byTimestamp.get(frame.timestamp);
          if (p === undefined || frames.has(p)) frame.close();
          else frames.set(p, frame);
        },
        error: (e) => failure.push(e),
      });
      const failure: DOMException[] = [];
      decoder.configure(this.config());
      for (const s of run) {
        decoder.decode(new EncodedVideoChunk({
          type: s.sync ? 'key' : 'delta',
          timestamp: Math.round((s.cts * 1e6) / this.info.timescale),
          duration: Math.round((s.duration * 1e6) / this.info.timescale),
          data: new Uint8Array(data, s.offset - lo, s.size),
        }));
      }
      await decoder.flush().catch((e: unknown) => failure.push(e as DOMException));
      decoder.close();
      if (failure.length) {
        for (const f of frames.values()) f.close();
        throw new Error(`Could not decode the proxy: ${failure[0]!.message}`);
      }
      const ps = run.map((s) => this.presOf[s.index]!);
      return { first: Math.min(...ps), last: Math.max(...ps), frames };
    })();
  }

  private gopFor(presIdx: number): Promise<Gop> {
    const decodeIdx = this.info.presentation[presIdx]!;
    const start = this.gopStart[decodeIdx]!;
    let g = this.gops.get(start);
    if (!g) {
      g = this.decodeGop(start);
      this.gops.set(start, g);
      this.order.push(start);
      g.catch(() => this.evict(start, true));
      // LRU: keep the most recent GOPs only
      while (this.order.length > this.maxGops) this.evict(this.order[0]!, false);
    } else {
      const i = this.order.indexOf(start);
      if (i >= 0) (this.order.splice(i, 1), this.order.push(start));
    }
    return g;
  }

  private evict(start: number, failed: boolean): void {
    const g = this.gops.get(start);
    this.gops.delete(start);
    const i = this.order.indexOf(start);
    if (i >= 0) this.order.splice(i, 1);
    if (!failed) void g?.then((x) => x.frames.forEach((f) => f.close())).catch(() => undefined);
  }

  /** The decoded frame at presentation index `p`. */
  async frame(p: number): Promise<VideoFrame> {
    const idx = Math.max(0, Math.min(this.info.presentation.length - 1, p));
    const gop = await this.gopFor(idx);
    const f = gop.frames.get(idx);
    if (!f) throw new Error(`Frame ${idx} was not produced by the decoder.`);
    return f;
  }

  /** Start decoding the GOP after the one containing `p`, so playback never waits at a GOP boundary. */
  prefetchAfter(p: number): void {
    if (this.maxGops < 2) return; // a second GOP would push the one being shown out of the cache
    const decodeIdx = this.info.presentation[Math.min(p, this.info.presentation.length - 1)]!;
    const next = this.gopStart[decodeIdx]! + 1;
    for (let i = next; i < this.info.samples.length; i++) {
      if (this.info.samples[i]!.sync) {
        void this.gopFor(this.presOf[i]!).catch(() => undefined);
        return;
      }
    }
  }

  dispose(): void {
    for (const start of [...this.order]) this.evict(start, false);
    this.decoder?.close();
  }
}

const MAX_GOP_BYTES = 1.2 * 1024 ** 3;

/**
 * Can this browser decode the original file well enough to export from it? Checks the codec (WebCodecs support, which
 * is what rules out H.264/HEVC in some browsers) and that one decoded GOP fits in memory (long-GOP 4K does not).
 */
export async function probeDecodable(url: string, opts: { singleGop?: boolean } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (typeof VideoDecoder === 'undefined') return { ok: false, reason: 'this browser has no WebCodecs' };
  try {
    const info = await openVideoTrack(url);
    const cfg: VideoDecoderConfig = { codec: info.codec, codedWidth: info.width, codedHeight: info.height, ...(info.description ? { description: info.description } : {}) };
    const sup = await VideoDecoder.isConfigSupported(cfg);
    if (!sup.supported) return { ok: false, reason: `this browser cannot decode ${info.codec}` };
    let longest = 0;
    let run = 0;
    for (const s of info.samples) {
      run = s.sync ? 1 : run + 1;
      longest = Math.max(longest, run);
    }
    if (longest * info.width * info.height * 1.5 * (opts.singleGop ? 1 : 2) > MAX_GOP_BYTES) return { ok: false, reason: `its GOP is ${longest} frames of ${info.width}×${info.height}, too large to decode in the browser` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
