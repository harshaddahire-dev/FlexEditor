import { create } from 'zustand';
import type { Sequence, Transform } from '@cutroom/core';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';
import { BlackGuard } from './blackGuard';
import { Compositor, type RenderItem } from './compositor';
import { FrameBuilder } from './frameBuilder';
import { setSoftwareDecode, useSoftwareDecode } from './videoSource';

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

/**
 * Drives the program monitor. Whenever the playhead, sequence or media change it asks for a render; requests are
 * latest-wins, so a slow decode during scrubbing never queues stale frames. Each draw resolves, for every video
 * clip under the playhead, the exact proxy frame (integer math in sequence ticks), then composites them in WebGL.
 */
export class PlaybackEngine {
  private compositor: Compositor | null = null;
  private host: HTMLElement | null = null;
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
        const canvas = this.compositor.canvas;
        // a graphics-driver reset loses the WebGL context and the canvas goes black: say so, and start again when it is back
        canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          useViewerStatus.setState({ error: 'The graphics driver reset and the picture was lost. Restoring…' });
        });
        canvas.addEventListener('webglcontextrestored', () => {
          this.compositor?.dispose();
          this.compositor = null;
          canvas.remove();
          useViewerStatus.setState({ error: null });
          if (this.host) this.attach(this.host);
          this.request();
        });
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

  private readonly frames = Object.assign(new FrameBuilder('proxy'), { onChange: () => this.request() });

  /** Live edits from the on-canvas handles: shown immediately, committed to the sequence when the drag ends. */
  setOverride(clipId: string, t: Partial<Transform> | null): void {
    if (t) this.frames.overrides.set(clipId, t);
    else this.frames.overrides.delete(clipId);
    this.request();
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

    const built = await this.frames.build(ticks, seq, media);
    // A newer request arrived while decoding: it will paint instead.
    if (this.want !== null) return;
    const { items, waiting } = built;

    comp.render(items);
    this.shown = { ticks, layers: built.layers };
    this.watchForBlack(items, comp, seq);
    this.stats = { rendered: this.stats.rendered + 1, dropped: this.stats.dropped, lastMs: performance.now() - started };
    const st = useViewerStatus.getState();
    if (st.waiting !== waiting || st.error !== this.blackError) useViewerStatus.setState({ waiting, error: this.blackError });
  }

  private readonly guard = new BlackGuard();
  private blackError: string | null = null;

  /** A decoded, bright frame that comes out black means the hardware decode/upload path is broken here: switch to software. */
  private watchForBlack(items: RenderItem[], comp: Compositor, seq: Sequence): void {
    let verdict: ReturnType<BlackGuard['check']>;
    try {
      verdict = this.guard.check(items, comp, seq.width, seq.height);
    } catch {
      return; // the check itself must never break playback
    }
    if (verdict !== 'black') return;
    if (!useSoftwareDecode()) {
      console.warn('[viewer] decoded frames come out black; switching to software decoding');
      setSoftwareDecode(true);
      this.frames.dispose();
      this.guard.reset();
      this.request();
    } else {
      this.blackError = 'Video frames are decoded but cannot be shown on this graphics setup. Use Copy diagnostics and send it along.';
      this.guard.settle();
      useViewerStatus.setState({ error: this.blackError });
    }
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.frames.dispose();
    this.compositor?.dispose();
    this.compositor = null;
  }

  /** RGBA of one pixel of the program frame (sequence pixels, top-left origin). */
  pixel(x: number, y: number): [number, number, number, number] | null {
    return this.compositor?.readPixel(x, y) ?? null;
  }
}

export const engine = new PlaybackEngine();
