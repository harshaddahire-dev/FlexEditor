import { type Clip, type Sequence, type Track, type TrackItem, frameTicks, isClip, itemEnd } from '@cutroom/core';
import type { SequenceDiff } from '@cutroom/core';
import type { FilmstripData, SilenceData, WaveformData } from '../store/analysis';
import { drawSilences, drawWaveform } from './waveform';
import { RULER_H, type View, rulerTicks, ticksToX, trackRows, visibleItems } from './geometry';

export interface Theme {
  bg0: string; bg1: string; bg2: string; bg3: string; line: string;
  text1: string; text2: string; text3: string;
  accent: string; accentSoft: string; playhead: string; success: string; warn: string; danger: string;
  clipVideo: string; clipAudio: string; clipCaption: string; clipGraphics: string;
  clipVideoHd: string; clipAudioHd: string; clipCaptionHd: string; clipGraphicsHd: string;
  fontUi: string; fontMono: string;
}

export function readTheme(el: Element = document.documentElement): Theme {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg0: v('--bg-0', '#111112'), bg1: v('--bg-1', '#19191b'), bg2: v('--bg-2', '#222225'), bg3: v('--bg-3', '#2b2b2f'), line: v('--line', '#2a2a2e'),
    text1: v('--text-1', '#e7e9ec'), text2: v('--text-2', '#a4abb4'), text3: v('--text-3', '#6b737d'),
    accent: v('--accent', '#4c8dff'), accentSoft: v('--accent-soft', 'rgba(76,141,255,.14)'), playhead: v('--playhead', '#ff5436'),
    success: v('--success', '#3dbe8b'), warn: v('--warn', '#e8b33a'), danger: v('--danger', '#f0524f'),
    clipVideo: v('--clip-video', '#3a5a86'), clipAudio: v('--clip-audio', '#2f6b52'), clipCaption: v('--clip-caption', '#8c7330'), clipGraphics: v('--clip-graphics', '#6e4e99'),
    clipVideoHd: v('--clip-video-hd', '#4f73a6'), clipAudioHd: v('--clip-audio-hd', '#3f8a6b'), clipCaptionHd: v('--clip-caption-hd', '#a68a3a'), clipGraphicsHd: v('--clip-graphics-hd', '#8a63b8'),
    fontUi: v('--font-ui', 'Inter, sans-serif'), fontMono: v('--font-mono', 'monospace'),
  };
}

/** A drag in progress, drawn as a ghost until the server confirms the edit. */
export type Preview =
  | { kind: 'move'; ids: ReadonlySet<string>; delta: number; toTrackId?: string; invalid?: boolean }
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; to: number; ripple?: boolean };

export interface DrawParams {
  seq: Sequence;
  view: View;
  theme: Theme;
  /** Canvas size in CSS pixels (ruler + lanes). */
  width: number;
  height: number;
  playhead: number;
  inPoint: number | null;
  outPoint: number | null;
  selection: ReadonlySet<string>;
  hoverId?: string | null;
  preview?: Preview | null;
  snapGuide?: number | null;
  /** Poster image for a media id, if loaded. */
  poster?: (mediaId: string) => CanvasImageSource | null;
  mediaName?: (mediaId: string) => string | undefined;
  /** Media intelligence caches (null until loaded). */
  waveform?: (mediaId: string) => WaveformData | null;
  filmstrip?: (mediaId: string) => FilmstripData | null;
  silences?: (mediaId: string) => SilenceData | null;
  /** What the agent run under review changed (for the ghost overlay). */
  review?: SequenceDiff | null;
}

const kindColor = (t: Theme, kind: Track['kind']): string => ({ video: t.clipVideo, audio: t.clipAudio, caption: t.clipCaption, graphics: t.clipGraphics })[kind];
const headColor = (t: Theme, kind: Track['kind']): string => ({ video: t.clipVideoHd, audio: t.clipAudioHd, caption: t.clipCaptionHd, graphics: t.clipGraphicsHd })[kind];

/** Crisp 1px line at the pixel centre. */
function vline(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number): void {
  const px = Math.round(x) + 0.5;
  ctx.beginPath();
  ctx.moveTo(px, y0);
  ctx.lineTo(px, y1);
  ctx.stroke();
}

function itemLabel(item: TrackItem, p: DrawParams): string {
  if (isClip(item)) return item.name ?? p.mediaName?.(item.mediaId) ?? item.mediaId;
  return item.words.map((w) => w.text).join(' ') || 'Caption';
}

function drawItem(ctx: CanvasRenderingContext2D, p: DrawParams, row: { y: number; h: number }, track: Track, item: TrackItem, start: number, end: number, ghost = false, rowOverrideY?: number): void {
  const { view, theme: t, seq } = p;
  const rate = seq.timebase.rate;
  const x0 = ticksToX(start, rate, view);
  const x1 = ticksToX(end, rate, view);
  if (x1 < -2 || x0 > view.width + 2) return;
  const y = RULER_H + (rowOverrideY ?? row.y) - view.scrollY + 1;
  const h = row.h - 2;
  const w = Math.max(1, x1 - x0);
  const selected = p.selection.has(item.id);
  const clip = isClip(item) ? item : null;
  const disabled = clip && !clip.enabled;

  ctx.save();
  ctx.globalAlpha = ghost ? 0.55 : disabled ? 0.4 : 1;
  const base = kindColor(t, track.kind);
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.roundRect(x0, y, w, h, 2);
  ctx.fill();
  ctx.clip();

  // title bar: a lighter band in the clip's colour, like the grading-suite timelines
  if (w > 3) {
    ctx.fillStyle = headColor(t, track.kind);
    ctx.fillRect(x0, y, w, Math.min(15, h));
  }
  // video: filmstrip tiles across the clip, falling back to the poster at its head
  const strip = clip && track.kind === 'video' && h > 26 ? p.filmstrip?.(clip.mediaId) : null;
  if (clip && strip) {
    const th = h - 15;
    const tw = Math.max(8, Math.round((th * strip.thumbW) / strip.thumbH));
    const speed = clip.speed.num / clip.speed.den;
    const first = Math.max(x0, 0);
    const last = Math.min(x1, view.width);
    ctx.globalAlpha = (ghost ? 0.55 : 1) * 0.9;
    for (let tx = x0 + Math.floor((first - x0) / tw) * tw; tx < last; tx += tw) {
      const mid = clip.start + ((Math.min(Math.max(tx + tw / 2, x0), x1) - x0) / view.pps) * rate; // timeline ticks at the tile centre
      const srcSec = (clip.sourceIn + (mid - clip.start) * speed) / rate;
      const idx = Math.max(0, Math.min(strip.count - 1, Math.floor(srcSec / strip.interval)));
      const sw = Math.min(tw, x1 - tx);
      ctx.drawImage(strip.image, (idx % strip.cols) * strip.thumbW, Math.floor(idx / strip.cols) * strip.thumbH, (strip.thumbW * sw) / tw, strip.thumbH, tx, y + 15, sw, th);
    }
    ctx.globalAlpha = ghost ? 0.55 : 1;
  } else if (clip && track.kind === 'video' && h > 26 && p.poster) {
    const img = p.poster(clip.mediaId);
    if (img && w > h * 1.6 + 24) {
      const th = h - 16;
      ctx.globalAlpha = (ghost ? 0.55 : 1) * 0.95;
      ctx.drawImage(img, x0 + 2, y + 15, Math.round((th * 16) / 9), th);
      ctx.globalAlpha = ghost ? 0.55 : 1;
    }
  }
  // audio: waveform, silences, centre line and fades
  if (clip && track.kind === 'audio' && h > 22) {
    const box = { x0, x1, y: y + 15, h: h - 15 };
    const sil = p.silences?.(clip.mediaId);
    if (sil) drawSilences(ctx, sil, clip, rate, view, box, 'rgba(0,0,0,0.28)');
    const wf = p.waveform?.(clip.mediaId);
    if (wf) drawWaveform(ctx, wf, clip, rate, view, box, 'rgba(255,255,255,0.78)', 10 ** (clip.audio.gainDb / 20));
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    const cy = Math.round(y + 15 + (h - 15) / 2) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, cy);
    ctx.lineTo(x1, cy);
    ctx.stroke();
    const fi = (clip.audio.fadeIn / rate) * view.pps;
    const fo = (clip.audio.fadeOut / rate) * view.pps;
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    if (fi > 1) (ctx.beginPath(), ctx.moveTo(x0, y + h), ctx.lineTo(x0 + fi, y + 15), ctx.lineTo(x0, y + 15), ctx.closePath(), ctx.fill());
    if (fo > 1) (ctx.beginPath(), ctx.moveTo(x1, y + h), ctx.lineTo(x1 - fo, y + 15), ctx.lineTo(x1, y + 15), ctx.closePath(), ctx.fill());
  }
  if (w > 28) {
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.font = `500 11px ${t.fontUi}`;
    ctx.textBaseline = 'top';
    const badges = clip && (clip.speed.num !== clip.speed.den ? ` ×${(clip.speed.num / clip.speed.den).toFixed(2).replace(/\.?0+$/, '')}` : '') + (clip && clip.audio.gainDb !== 0 && track.kind === 'audio' ? ` ${clip.audio.gainDb > 0 ? '+' : ''}${clip.audio.gainDb.toFixed(0)} dB` : '');
    ctx.fillText(itemLabel(item, p) + (badges ?? ''), x0 + 5, y + 2, Math.max(0, w - 10));
  }
  // hairline edge so adjacent clips read as separate pieces
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x0 + 0.5, y + 0.5, Math.max(1, w - 1), h - 1, 2);
  ctx.stroke();
  ctx.restore();

  // outlines: agent-made (until accepted), selected, hovered
  const agent = item.createdBy !== 'user' && !item.accepted;
  if (agent || selected || p.hoverId === item.id) {
    ctx.save();
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.strokeStyle = selected ? '#ffffff' : t.accent;
    if (selected) (ctx.shadowColor = 'rgba(255,255,255,0.35)', ctx.shadowBlur = 4);
    ctx.globalAlpha = ghost ? 0.7 : selected ? 1 : p.hoverId === item.id && !agent ? 0.45 : 1;
    ctx.beginPath();
    ctx.roundRect(x0 + 0.5, y + 0.5, Math.max(1, w - 1), h - 1, 3);
    ctx.stroke();
    if (agent && w > 34) {
      ctx.fillStyle = t.accent;
      ctx.beginPath();
      ctx.roundRect(x1 - 20, y + 2, 17, 11, 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `600 8px ${t.fontUi}`;
      ctx.textBaseline = 'middle';
      ctx.fillText('AI', x1 - 16, y + 8);
    }
    ctx.restore();
  }
}

/**
 * The review overlay: where removed items used to be (red, dashed) and where changed items used to sit (amber, dashed),
 * so a run's cuts can be judged on the timeline itself. Added items need no ghost — they carry the "AI" badge.
 */
export function drawReview(ctx: CanvasRenderingContext2D, p: DrawParams, diff: SequenceDiff): void {
  const { seq, view, theme: t, width, height } = p;
  const rate = seq.timebase.rate;
  const rows = new Map(trackRows(seq).map((r) => [r.track.id, r]));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_H, width, height - RULER_H);
  ctx.clip();
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  const box = (it: { trackId: string; start: number; duration: number }, stroke: string, fill: string) => {
    const row = rows.get(it.trackId);
    if (!row) return;
    const x0 = ticksToX(it.start, rate, view);
    const x1 = ticksToX(it.start + it.duration, rate, view);
    if (x1 < 0 || x0 > width) return;
    const y = RULER_H + row.y - view.scrollY + 2;
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.fillRect(x0, y, Math.max(2, x1 - x0), row.h - 4);
    ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(2, x1 - x0) - 1, row.h - 5);
  };
  for (const r of diff.removed) box(r, t.danger, 'rgba(240,82,79,0.14)');
  for (const c of diff.changed) if (c.what.includes('moved') || c.what.includes('trimmed') || c.what.includes('track')) box(c.before, t.warn, 'rgba(232,179,58,0.10)');
  ctx.restore();
}

/** Paint the whole timeline canvas (ruler + lanes + playhead). Cost is proportional to what is visible, not to clip count. */
export function drawTimeline(ctx: CanvasRenderingContext2D, p: DrawParams): void {
  const { seq, view, theme: t, width, height } = p;
  const rate = seq.timebase.rate;
  const rows = trackRows(seq);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = t.bg0;
  ctx.fillRect(0, 0, width, height);

  /* lanes */
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_H, width, height - RULER_H);
  ctx.clip();
  rows.forEach((row, i) => {
    const y = RULER_H + row.y - view.scrollY;
    if (y + row.h < RULER_H || y > height) return;
    ctx.fillStyle = i % 2 ? t.bg1 : t.bg0;
    ctx.fillRect(0, y, width, row.h);
    ctx.fillStyle = t.line;
    ctx.fillRect(0, y + row.h, width, 1);
    if (row.track.locked) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, y, width, row.h);
      ctx.restore();
    }
  });

  /* items — only those overlapping the viewport */
  const t0 = (view.scrollX / view.pps) * rate;
  const t1 = ((view.scrollX + width) / view.pps) * rate;
  const preview = p.preview;
  const movingIds = preview?.kind === 'move' ? preview.ids : null;
  for (const row of rows) {
    const y = RULER_H + row.y - view.scrollY;
    if (y + row.h < RULER_H || y > height) continue;
    const muted = row.track.muted;
    ctx.save();
    if (muted) ctx.globalAlpha = 0.5;
    for (const item of visibleItems(row.track, t0, t1)) {
      if (movingIds?.has(item.id)) {
        // the original keeps a faint outline where it will leave from
        ctx.save();
        ctx.globalAlpha = 0.25;
        drawItem(ctx, p, row, row.track, item, item.start, itemEnd(item));
        ctx.restore();
        continue;
      }
      let s = item.start;
      let e = itemEnd(item);
      if (preview?.kind === 'trim' && preview.id === item.id) {
        if (preview.edge === 'start') s = Math.min(preview.to, e - frameTicks(seq.timebase));
        else e = Math.max(preview.to, s + frameTicks(seq.timebase));
      }
      drawItem(ctx, p, row, row.track, item, s, e);
    }
    ctx.restore();

    // transitions sit over the cut they belong to
    for (const tr of row.track.transitions) {
      const a = row.track.items[tr.betweenClipIds[0]];
      if (!a) continue;
      const cut = itemEnd(a);
      const [s, e] = tr.alignment === 'center' ? [cut - tr.duration / 2, cut + tr.duration / 2] : tr.alignment === 'start' ? [cut, cut + tr.duration] : [cut - tr.duration, cut];
      const x0 = ticksToX(s, rate, view);
      const x1 = ticksToX(e, rate, view);
      if (x1 < 0 || x0 > width) continue;
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x0, y + 3, Math.max(4, x1 - x0), row.h - 6, 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  /* ghosts for a drag */
  if (preview?.kind === 'move') {
    for (const row of rows) {
      for (const item of Object.values(row.track.items)) {
        if (!preview.ids.has(item.id)) continue;
        const target = preview.toTrackId && preview.ids.size === 1 ? rows.find((r) => r.track.id === preview.toTrackId) : undefined;
        const useRow = target ?? row;
        drawItem(ctx, preview.invalid ? { ...p, selection: new Set() } : p, useRow, useRow.track, item, item.start + preview.delta, itemEnd(item) + preview.delta, true);
        if (preview.invalid) {
          ctx.save();
          ctx.strokeStyle = t.danger;
          ctx.lineWidth = 2;
          const x0 = ticksToX(item.start + preview.delta, rate, view);
          const x1 = ticksToX(itemEnd(item) + preview.delta, rate, view);
          ctx.strokeRect(x0, RULER_H + useRow.y - view.scrollY + 1, x1 - x0, useRow.h - 2);
          ctx.restore();
        }
      }
    }
  }
  ctx.restore();

  /* ruler */
  ctx.fillStyle = t.bg2;
  ctx.fillRect(0, 0, width, RULER_H);
  ctx.fillStyle = t.line;
  ctx.fillRect(0, RULER_H - 1, width, 1);
  if (p.inPoint !== null || p.outPoint !== null) {
    const a = ticksToX(p.inPoint ?? 0, rate, view);
    const b = p.outPoint !== null ? ticksToX(p.outPoint, rate, view) : width;
    ctx.fillStyle = t.accentSoft;
    ctx.fillRect(Math.max(0, a), 0, Math.max(0, Math.min(width, b) - Math.max(0, a)), RULER_H - 1);
    ctx.fillStyle = t.accent;
    if (p.inPoint !== null) ctx.fillRect(Math.round(a), 0, 2, RULER_H - 1);
    if (p.outPoint !== null) ctx.fillRect(Math.round(b) - 2, 0, 2, RULER_H - 1);
  }
  const { major, minor } = rulerTicks(seq, view);
  ctx.strokeStyle = t.line;
  ctx.lineWidth = 1;
  for (const m of minor) if (m.x >= 0 && m.x <= width) vline(ctx, m.x, RULER_H - 6, RULER_H - 1);
  ctx.fillStyle = t.text2;
  ctx.font = `500 10px ${t.fontMono}`;
  ctx.textBaseline = 'top';
  for (const m of major) {
    if (m.x < -60 || m.x > width) continue;
    ctx.strokeStyle = t.text3;
    vline(ctx, m.x, RULER_H - 11, RULER_H - 1);
    ctx.fillText(m.label ?? '', m.x + 4, 4);
  }
  /* markers */
  for (const m of seq.markers) {
    const x = ticksToX(m.time, rate, view);
    if (x < -8 || x > width + 8) continue;
    ctx.strokeStyle = t.warn;
    ctx.globalAlpha = 0.45;
    vline(ctx, x, RULER_H, height);
    ctx.globalAlpha = 1;
    ctx.fillStyle = t.warn;
    ctx.beginPath();
    ctx.moveTo(x - 5, RULER_H - 10);
    ctx.lineTo(x + 5, RULER_H - 10);
    ctx.lineTo(x + 5, RULER_H - 4);
    ctx.lineTo(x, RULER_H - 1);
    ctx.lineTo(x - 5, RULER_H - 4);
    ctx.closePath();
    ctx.fill();
  }

  if (p.review) drawReview(ctx, p, p.review);

  /* snap guide */
  if (p.snapGuide != null) {
    const x = ticksToX(p.snapGuide, rate, view);
    ctx.strokeStyle = t.accent;
    ctx.setLineDash([3, 3]);
    vline(ctx, x, 0, height);
    ctx.setLineDash([]);
  }

  /* playhead (always last, always on top) */
  const px = ticksToX(p.playhead, rate, view);
  if (px >= -8 && px <= width + 8) {
    ctx.strokeStyle = t.playhead;
    ctx.lineWidth = 1;
    vline(ctx, px, 0, height);
    ctx.fillStyle = t.playhead;
    ctx.beginPath();
    const cx = Math.round(px) + 0.5;
    ctx.moveTo(cx - 6, 1);
    ctx.lineTo(cx + 6, 1);
    ctx.lineTo(cx + 6, 8);
    ctx.lineTo(cx, 15);
    ctx.lineTo(cx - 6, 8);
    ctx.closePath();
    ctx.fill();
  }
}

export type { Clip };
