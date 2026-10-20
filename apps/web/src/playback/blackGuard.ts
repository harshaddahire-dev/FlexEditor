import type { Compositor, RenderItem } from './compositor';

let probe: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null = null;

/** Brightest channel (0–255) of a decoded frame, from an 8×8 downscale drawn with the 2D canvas (a path independent of WebGL). */
export function frameBrightness(frame: VideoFrame): number {
  if (!probe) {
    const canvas = new OffscreenCanvas(8, 8);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;
    probe = { canvas, ctx };
  }
  probe.ctx.drawImage(frame, 0, 0, 8, 8);
  const d = probe.ctx.getImageData(0, 0, 8, 8).data;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i]!, d[i + 1]!, d[i + 2]!);
  return max;
}

/**
 * Catches "the frame decoded fine but the monitor is black": the picture is drawn plain (one opaque layer, no effects) and the
 * source frame is clearly bright, yet the compositor's output is pure black at nine points around the centre. That means this
 * machine could not put the decoded frame on the WebGL canvas (a hardware-decoder / GPU-upload fault), which no amount of
 * waiting fixes.
 */
export class BlackGuard {
  private bad = 0;
  private good = 0;
  private settled = false;

  get done(): boolean {
    return this.settled;
  }

  /** Stop checking (the verdict is final). */
  settle(): void {
    this.settled = true;
  }

  reset(): void {
    this.bad = 0;
    this.good = 0;
    this.settled = false;
  }

  /** `'black'` after two bad frames in a row; `'ok'` once the picture has been seen twice; otherwise undefined. */
  check(items: RenderItem[], comp: Compositor, width: number, height: number): 'black' | 'ok' | undefined {
    if (this.settled || items.length !== 1) return;
    const item = items[0]!;
    if (item.kind !== 'layer') return;
    const { source, opacity, effects, crop } = item.layer;
    if (typeof VideoFrame === 'undefined' || !(source instanceof VideoFrame)) return;
    if (opacity < 0.99 || effects?.length || crop.left || crop.right || crop.top || crop.bottom) return;
    if (frameBrightness(source) < 48) return; // a dark picture cannot tell us anything
    let out = 0;
    for (const fx of [0.42, 0.5, 0.58]) for (const fy of [0.42, 0.5, 0.58]) out = Math.max(out, ...comp.readPixel(width * fx, height * fy).slice(0, 3));
    if (out > 3) {
      if (++this.good >= 2) {
        this.settled = true;
        return 'ok';
      }
      this.bad = 0;
      return;
    }
    return ++this.bad >= 2 ? 'black' : undefined;
  }
}
