import { type Clip, type Media, type Sequence, type Transform, defaultTransform, resolveEffectParams } from '@cutroom/core';
import { mediaUrl } from '../lib/api';
import { CaptionPainter } from './captions';
import { type Drawable, type Layer, type RenderItem } from './compositor';
import { activeCaptions, layerMatrix, planFrame, resolveTransform, sourceTicksAt } from './layers';
import { VideoSource } from './videoSource';

type SourceEntry = { key: string; ready: Promise<VideoSource | ImageBitmap> };

/** Which file a clip is decoded from: the proxy (fast, what the monitor shows) or the original (export quality). */
export type SourcePolicy = 'proxy' | 'original';

export interface BuiltFrame {
  items: RenderItem[];
  /** Layers drawn (what the e2e tests assert frame accuracy against). */
  layers: { clipId: string; mediaId: string; index: number }[];
  /** Clips under the playhead whose source is not ready (or cannot be decoded) yet. */
  waiting: number;
}

/**
 * Turns "what is at this tick" into drawable layers: decodes the exact source frame of every visible clip, resolves
 * transform, keyframes and effects, and adds the burned-in captions. The monitor and the exporter both use it, so
 * a frame is the same whichever one asks.
 */
export class FrameBuilder {
  private readonly sources = new Map<string, SourceEntry>();
  private captions: CaptionPainter | null = null;
  /** Live edits from the on-canvas handles (monitor only). */
  readonly overrides = new Map<string, Partial<Transform>>();

  constructor(readonly policy: SourcePolicy) {}

  source(media: Media): Promise<VideoSource | ImageBitmap> | null {
    if (media.type === 'image') {
      return this.cached(media, 'original', async () => createImageBitmap(await (await fetch(mediaUrl(media.id, 'original', media.mtimeMs))).blob()));
    }
    if (this.policy === 'original') return this.cached(media, 'original', () => VideoSource.open(mediaUrl(media.id, 'original', media.mtimeMs)));
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

  /** Resolve one clip into a drawable layer at `ticks` (decoded frame or still, transform, keyframes, effects). */
  async layerFor(clip: Clip, ticks: number, seq: Sequence, media: Record<string, Media>, rate: number): Promise<{ layer: Layer; info: { clipId: string; mediaId: string; index: number } } | null> {
    const m = media[clip.mediaId];
    const pending = m && !m.missing ? this.source(m) : null;
    if (!pending) return null;
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
    const t = { ...resolveTransform(clip, rel), ...(this.overrides.get(clip.id) ?? {}) };
    const fit = Math.min(seq.width / srcW, seq.height / srcH);
    const effects = clip.effects.filter((e) => e.enabled).map((e) => ({ type: e.type, params: resolveEffectParams(e, clip, rel) }));
    const layer: Layer = { source: drawable, srcW, srcH, matrix: layerMatrix(t, srcW, srcH, seq.width, seq.height), opacity: t.opacity, crop: t.crop, ...(effects.length ? { effects, pixelScale: 1 / fit } : {}) };
    return { layer, info: { clipId: clip.id, mediaId: clip.mediaId, index } };
  }

  /** Everything to draw at `ticks`, bottom of the stack first, captions on top. */
  async build(ticks: number, seq: Sequence, media: Record<string, Media>): Promise<BuiltFrame> {
    const rate = seq.timebase.rate;
    let waiting = 0;
    const layers: BuiltFrame['layers'] = [];
    const rendered = await Promise.all(
      planFrame(seq, ticks).map(async (p): Promise<RenderItem | null> => {
        if (p.kind === 'clip') {
          const r = await this.layerFor(p.clip, ticks, seq, media, rate);
          if (!r) return (waiting++, null);
          layers.push(r.info);
          return { kind: 'layer', layer: r.layer };
        }
        const [a, b] = await Promise.all([this.layerFor(p.from, ticks, seq, media, rate), this.layerFor(p.to, ticks, seq, media, rate)]);
        if (!a || !b) {
          waiting++;
          const only = a ?? b;
          return only ? { kind: 'layer', layer: only.layer } : null;
        }
        layers.push(a.info, b.info);
        return { kind: 'transition', type: p.transition.type, progress: p.progress, from: a.layer, to: b.layer };
      }),
    );
    const items = rendered.filter((r): r is RenderItem => r !== null);
    const caps = activeCaptions(seq, ticks);
    if (caps.length) {
      this.captions ??= new CaptionPainter(seq.width, seq.height, () => seq.timebase.rate);
      this.captions.resize(seq.width, seq.height);
      this.captions.paint(caps.map(({ caption }) => ({ caption, t: ticks })));
      items.push({ kind: 'layer', layer: { source: this.captions.canvas, version: this.captions.version, srcW: seq.width, srcH: seq.height, matrix: layerMatrix(defaultTransform(), seq.width, seq.height, seq.width, seq.height), opacity: 1, crop: { left: 0, right: 0, top: 0, bottom: 0 } } });
    }
    return { items, layers, waiting };
  }

  dispose(): void {
    for (const e of this.sources.values()) void e.ready.then((s) => (s instanceof VideoSource ? s.dispose() : s.close())).catch(() => undefined);
    this.sources.clear();
  }
}
