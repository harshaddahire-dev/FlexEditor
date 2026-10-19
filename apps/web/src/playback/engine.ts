import { create } from 'zustand';
import type { Media, Sequence } from '@cutroom/core';
import { mediaUrl } from '../lib/api';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';
import { Compositor, type Drawable, type Layer } from './compositor';
import { activeVideoClips, layerMatrix, resolveTransform, sourceTicksAt } from './layers';
import { VideoSource } from './videoSource';

export interface ViewerStatus {
  /** Set when a proxy cannot be decoded; shown over the monitor. */
  error: string | null;
  /** Clips under the playhead whose proxy is not ready yet. */
  waiting: number;
}
export const useViewerStatus = create<ViewerStatus>()(() => ({ error: null, waiting: 0 }));

/** What the monitor last painted — also the contract the e2e tests assert frame accuracy against. */
export interface Shown {
  ticks: number;
  layers: { clipId: string; mediaId: string; index: number }[];
}

export interface PlaybackStats {
  rendered: number;
  /** Requests superseded before they could be drawn (latest-wins). */
  dropped: number;
  lastMs: number;
}

type SourceEntry = { key: string; ready: Promise<VideoSource | ImageBitmap> };

/**
 * Drives the program monitor. Whenever the playhead, sequence or media change it asks for a render; requests are
 * latest-wins, so a slow decode during scrubbing never queues stale frames. Each draw resolves, for every video
 * clip under the playhead, the exact proxy frame (integer math in sequence ticks), then composites them in WebGL.
 */
export class PlaybackEngine {
  private compositor: Compositor | null = null;
  private host: HTMLElement | null = null;
  private readonly sources = new Map<string, SourceEntry>();
  private want: number | null = null;
  private running = false;
  private unsubs: (() => void)[] = [];
  private idleWaiters: (() => void)[] = [];
  shown: Shown | null = null;
  stats: PlaybackStats = { rendered: 0, dropped: 0, lastMs: 0 };

  /** Mount the monitor canvas into `host` and start following the stores. */
  attach(host: HTMLElement): void {
    this.host = host;
    const seq = useApp.getState().sequence;
    this.ensureCompositor(seq);
    if (this.compositor && this.compositor.canvas.parentElement !== host) host.appendChild(this.compositor.canvas);
    if (this.unsubs.length) return;
    let prevSeq = useApp.getState().sequence;
    let prevMedia = useApp.getState().media;
    this.unsubs.push(
      useTimeline.subscribe((s, p) => s.playhead !== p.playhead && this.request()),
      useApp.subscribe((s) => {
        if (s.sequence === prevSeq && s.media === prevMedia) return;
        prevSeq = s.sequence;
        prevMedia = s.media;
        this.request();
      }),
    );
    this.request();
  }

  detach(): void {
    this.compositor?.canvas.remove();
    this.host = null;
  }

  get canvas(): HTMLCanvasElement | null {
    return this.compositor?.canvas ?? null;
  }

  private ensureCompositor(seq: Sequence | null): void {
    const w = seq?.width ?? 1920;
    const h = seq?.height ?? 1080;
    if (!this.compositor) {
      try {
        this.compositor = new Compositor(w, h);
        this.compositor.canvas.className = 'viewer__canvas';
        this.compositor.canvas.dataset.testid = 'program-canvas';
      } catch (e) {
        useViewerStatus.setState({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    this.compositor.resize(w, h);
  }

  /** Ask for a repaint at the current playhead. */
  request(): void {
    if (this.want !== null) this.stats.dropped++;
    this.want = useTimeline.getState().playhead;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.want !== null) {
        const t = this.want;
        this.want = null;
        try {
          await this.draw(t);
        } catch (e) {
          useViewerStatus.setState({ error: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      this.running = false;
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((f) => f());
    }
  }

  /** Resolves once no render is pending or running (test hook; also used before export frame grabs). */
  idle(): Promise<void> {
    return this.running || this.want !== null ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
  }

  private source(media: Media): Promise<VideoSource | ImageBitmap> | null {
    if (media.type === 'image') {
      return this.cached(media, 'original', async () => createImageBitmap(await (await fetch(mediaUrl(media.id, 'original', media.mtimeMs))).blob()));
    }
    if (media.status.proxy !== 'done') return null;
    return this.cached(media, `proxy:${media.proxy?.codec ?? ''}`, () => VideoSource.open(mediaUrl(media.id, 'proxy', `${media.mtimeMs}-${media.proxy?.codec ?? ''}`)));
  }

  private cached(media: Media, tag: string, make: () => Promise<VideoSource | ImageBitmap>): Promise<VideoSource | ImageBitmap> {
    const key = `${tag}:${media.mtimeMs}:${media.path}`;
    const hit = this.sources.get(media.id);
    if (hit && hit.key === key) return hit.ready;
    if (hit) void hit.ready.then((s) => (s instanceof VideoSource ? s.dispose() : s.close())).catch(() => undefined);
    const ready = make();
    ready.catch(() => this.sources.get(media.id)?.ready === ready && this.sources.delete(media.id));
    this.sources.set(media.id, { key, ready });
    return ready;
  }

  private async draw(ticks: number): Promise<void> {
    const started = performance.now();
    const { sequence: seq, media } = useApp.getState();
    this.ensureCompositor(seq);
    const comp = this.compositor;
    if (!comp) return;
    if (!seq) {
      comp.render([]);
      this.shown = { ticks, layers: [] };
      return;
    }

    const rate = seq.timebase.rate;
    let waiting = 0;
    const resolved = await Promise.all(
      activeVideoClips(seq, ticks).map(async ({ clip }) => {
        const m = media[clip.mediaId];
        const pending = m && !m.missing ? this.source(m) : null;
        if (!pending) {
          waiting++;
          return null;
        }
        const src = await pending;
        const rel = ticks - clip.start;
        let drawable: Drawable;
        let index = 0;
        let srcW: number;
        let srcH: number;
        if (src instanceof VideoSource) {
          index = src.indexAtTicks(sourceTicksAt(clip, ticks), rate);
          drawable = await src.frame(index);
          srcW = (drawable as VideoFrame).displayWidth;
          srcH = (drawable as VideoFrame).displayHeight;
          src.prefetchAfter(index);
        } else {
          drawable = src;
          srcW = src.width;
          srcH = src.height;
        }
        const t = resolveTransform(clip, rel);
        const layer: Layer = { source: drawable, srcW, srcH, matrix: layerMatrix(t, srcW, srcH, seq.width, seq.height), opacity: t.opacity, crop: t.crop };
        return { layer, info: { clipId: clip.id, mediaId: clip.mediaId, index } };
      }),
    );

    // A newer request arrived while decoding: it will paint instead.
    if (this.want !== null) return;
    const ok = resolved.filter((r): r is NonNullable<typeof r> => r !== null);
    comp.render(ok.map((r) => r.layer));
    this.shown = { ticks, layers: ok.map((r) => r.info) };
    this.stats = { rendered: this.stats.rendered + 1, dropped: this.stats.dropped, lastMs: performance.now() - started };
    const st = useViewerStatus.getState();
    if (st.waiting !== waiting || st.error) useViewerStatus.setState({ waiting, error: null });
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    for (const e of this.sources.values()) void e.ready.then((s) => (s instanceof VideoSource ? s.dispose() : s.close())).catch(() => undefined);
    this.sources.clear();
    this.compositor?.dispose();
    this.compositor = null;
  }

  /** RGBA of one pixel of the program frame (sequence pixels, top-left origin). */
  pixel(x: number, y: number): [number, number, number, number] | null {
    return this.compositor?.readPixel(x, y) ?? null;
  }
}

export const engine = new PlaybackEngine();
