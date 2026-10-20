import { type Clip, type Media, type Sequence, type Transition, isClip, itemEnd, resolveEffectParams, trackItems, transitionDef, transitionSpan, type Track } from '@cutroom/core';
import { effectGraph } from './fx';
import { Graph } from './graph';
import { keyframeExpr, num } from './expr';

/** The monitor's transition types as FFmpeg `xfade` names. Close, not identical, for the push/slide pair (see warnings). */
const XFADE: Record<string, string> = {
  dissolve: 'fade',
  'dip-black': 'fadeblack',
  'dip-white': 'fadewhite',
  'wipe-left': 'wipeleft',
  'wipe-right': 'wiperight',
  'wipe-up': 'wipeup',
  'wipe-down': 'wipedown',
  'slide-left': 'coverleft',
  'push-left': 'slideleft',
  'push-right': 'slideright',
  zoom: 'zoomin',
  iris: 'circleopen',
};

export interface VideoGraphInput {
  seq: Sequence;
  media: ReadonlyMap<string, Media>;
  /** Absolute path of the file to read for a media item (original, never the proxy). */
  pathOf(m: Media): string;
  /** Timeline range in ticks. */
  from: number;
  to: number;
  /** Burned-in captions: path of an ASS file (already timed relative to `from`). */
  assPath?: string;
  /** Output pixel format and colour conversion. */
  pixFmt: 'yuv420p' | 'yuv422p10le';
}

export interface VideoGraph {
  /** Frame rate as the exact rational FFmpeg takes, e.g. `30000/1001`. */
  fpsRational: string;
  /** ffmpeg input options, in order, each entry one `-i` group. */
  inputs: string[][];
  graph: string;
  /** Label of the final video stream. */
  out: string;
  warnings: string[];
  frames: number;
  fps: number;
}

interface LayerSpec {
  clip: Clip;
  media: Media;
  /** Timeline time (s, on the stream's own clock) of the first frame this stream shows. */
  tl0: number;
  /** Timeline seconds of this stream. */
  dur: number;
  /** Clock position of the clip's own start, so keyframe times (clip-relative) resolve. */
  clipAt: number;
  /** Source ticks at `tl0` (may sit before sourceIn / after the clip's end for transition handles). */
  srcTicks: number;
}

/** Static-or-expression number: constants stay constants so the common case is plain FFmpeg options. */
class Val {
  constructor(
    readonly expr: string,
    readonly constant: number | null,
  ) {}
  static of(clip: Clip, path: string, fallback: number, rate: number, clipAt: number, conv: (v: number) => number = (v) => v, v = 't'): Val {
    const kfs = clip.keyframes[path];
    if (!kfs?.length) return new Val(num(conv(fallback)), conv(fallback));
    const e = keyframeExpr(kfs, fallback, rate, clipAt, conv).replace(/\bt\b/g, v === 't' ? 't' : v);
    return new Val(e, null);
  }
}

/** Remove [cs, ce) from a list of [start, end) windows. */
export function subtract(windows: [number, number][], cs: number, ce: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of windows) {
    if (ce <= a || cs >= b) out.push([a, b]);
    else {
      if (cs > a) out.push([a, cs]);
      if (ce < b) out.push([ce, b]);
    }
  }
  return out;
}

/** Build the whole video side of an export as one filter_complex. */
export function buildVideoGraph(input: VideoGraphInput): VideoGraph {
  const { seq, media, from, to } = input;
  const rate = seq.timebase.rate;
  const fps = seq.timebase.fps.num / seq.timebase.fps.den;
  const W = seq.width;
  const H = seq.height;
  const R = from / rate;
  const dur = (to - from) / rate;
  const frames = Math.round(dur * fps);
  const fpsR = `${seq.timebase.fps.num}/${seq.timebase.fps.den}`;
  const warnings = new Set<string>();
  const g = new Graph();
  const inputs: string[][] = [];
  const sec = (ticks: number) => ticks / rate - R;
  const half = 0.5 / fps;

  const baseLabel = g.fresh('base');
  g.raw(`color=c=black:s=${W}x${H}:r=${fpsR}:d=${num(dur)},format=gbrp[${baseLabel}]`);
  let cur = baseLabel;

  /** One clip (or the stretch of it a transition needs) as an RGBA stream with its overlay position. */
  function layer(spec: LayerSpec): { label: string; x: string; y: string } | null {
    const { clip, media: m, tl0, dur: d, clipAt } = spec;
    const v = m.video;
    if (m.type !== 'video' && m.type !== 'image') return null;
    const srcW = v?.width ?? 0;
    const srcH = v?.height ?? 0;
    if (!srcW || !srcH) return null;
    const speed = clip.speed.num / clip.speed.den;
    const idx = inputs.length;
    if (m.type === 'image') inputs.push(['-loop', '1', '-framerate', fpsR, '-t', num(d + 1), '-i', input.pathOf(m)]);
    else {
      const srcSec = Math.max(0, spec.srcTicks / rate);
      const mf = m.fps ? m.fps.num / m.fps.den : fps;
      inputs.push(['-ss', num(Math.max(0, srcSec - 0.25 / mf)), '-i', input.pathOf(m)]);
    }
    const f: string[] = [];
    if (m.type === 'video') f.push(`trim=duration=${num(d * speed + 2 / fps)}`);
    f.push(`setpts='(PTS-STARTPTS)/${num(speed)}+${num(tl0)}/TB'`);
    if (v && (v.sar.num !== v.sar.den || v.rotation)) f.push(`scale=${v.width}:${v.height}`);
    let label = g.chain(`${idx}:v`, f);

    const fit = Math.min(W / srcW, H / srcH);
    // effects work on the source picture, before it is scaled into the frame
    for (const e of clip.effects) {
      if (!e.enabled) continue;
      const kfs = Object.keys(clip.keyframes).some((k) => k.startsWith(`effect:${e.id}.`));
      if (kfs) warnings.add('Animated effect parameters are rendered at their value at the clip start.');
      const r = effectGraph(g, label, e.type, resolveEffectParams(e, clip, 0), 1 / fit);
      if (r.approximate) warnings.add(`The FFmpeg engine only approximates the ${e.type} effect.`);
      label = r.out;
    }
    const t = clip.transform;
    const crop = { l: t.crop.left, r: t.crop.right, t: t.crop.top, b: t.crop.bottom };
    if (crop.l || crop.r || crop.t || crop.b) label = g.chain(label, [`crop=w=iw*${num(1 - crop.l - crop.r)}:h=ih*${num(1 - crop.t - crop.b)}:x=iw*${num(crop.l)}:y=ih*${num(crop.t)}`]);
    label = g.chain(label, ['format=rgba']);

    const sx = Val.of(clip, 'scale.x', t.scale.x, rate, clipAt);
    const sy = Val.of(clip, 'scale.y', t.scale.y, rate, clipAt);
    const rot = Val.of(clip, 'rotation', t.rotation, rate, clipAt, (x) => (x * Math.PI) / 180);
    const px = Val.of(clip, 'position.x', t.position.x, rate, clipAt);
    const py = Val.of(clip, 'position.y', t.position.y, rate, clipAt);
    const ax = Val.of(clip, 'anchor.x', t.anchor.x, rate, clipAt);
    const ay = Val.of(clip, 'anchor.y', t.anchor.y, rate, clipAt);
    const op = Val.of(clip, 'opacity', t.opacity, rate, clipAt, (x) => Math.max(0, Math.min(1, x)), 'T');

    const cw = 1 - crop.l - crop.r;
    const ch = 1 - crop.t - crop.b;
    // size of the whole (uncropped) picture in the frame, then of the visible part
    const fullW = (s: string) => `(${srcW * fit}*(${s}))`;
    const fullH = (s: string) => `(${srcH * fit}*(${s}))`;
    const staticXf = [sx, sy, rot, px, py, ax, ay].every((x) => x.constant !== null);
    const scaleF = staticXf
      ? `scale=w=${Math.max(2, Math.round(srcW * fit * cw * sx.constant!))}:h=${Math.max(2, Math.round(srcH * fit * ch * sy.constant!))}:flags=bicubic`
      : `scale=w='max(2,${fullW(sx.expr)}*${num(cw)})':h='max(2,${fullH(sy.expr)}*${num(ch)})':eval=frame:flags=bicubic`;
    const steps = [scaleF];
    if (rot.constant !== 0 || rot.constant === null) {
      if (rot.constant !== null) steps.push(`rotate=a=${num(rot.constant)}:c=none:ow=rotw(${num(rot.constant)}):oh=roth(${num(rot.constant)})`);
      else {
        const maxS = Math.max(...(clip.keyframes['scale.x'] ?? []).map((k) => k.value), t.scale.x, ...(clip.keyframes['scale.y'] ?? []).map((k) => k.value), t.scale.y);
        const diag = Math.ceil(Math.hypot(srcW * fit * maxS, srcH * fit * maxS)) + 2;
        steps.push(`rotate=a='${rot.expr}':c=none:ow=${diag}:oh=${diag}`);
      }
    }
    if (op.constant !== null) {
      if (op.constant < 0.999) steps.push(`colorchannelmixer=aa=${num(op.constant)}`);
    } else steps.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${op.expr},0,1)'`);
    label = g.chain(label, steps);

    // centre of the visible part, in frame pixels: the monitor's affine map evaluated at the crop centre
    const u = (crop.l + (1 - crop.r)) / 2;
    const vv = (crop.t + (1 - crop.b)) / 2;
    const cxy = (axisX: boolean): string => {
      const wE = fullW(sx.expr);
      const hE = fullH(sy.expr);
      const base = axisX ? `${W / 2}+(${px.expr})` : `${H / 2}+(${py.expr})`;
      const du = `(${num(u)}-(${ax.expr}))`;
      const dv = `(${num(vv)}-(${ay.expr}))`;
      const cos = `cos(${rot.expr})`;
      const sin = `sin(${rot.expr})`;
      return axisX ? `${base}+${cos}*${wE}*${du}-${sin}*${hE}*${dv}` : `${base}+${sin}*${wE}*${du}+${cos}*${hE}*${dv}`;
    };
    let X: string;
    let Y: string;
    if (staticXf) {
      const w = srcW * fit * sx.constant!;
      const h = srcH * fit * sy.constant!;
      const c = Math.cos(rot.constant!);
      const s = Math.sin(rot.constant!);
      const du = u - ax.constant!;
      const dv = vv - ay.constant!;
      X = `${num(W / 2 + px.constant! + c * w * du - s * h * dv)}-overlay_w/2`;
      Y = `${num(H / 2 + py.constant! + s * w * du + c * h * dv)}-overlay_h/2`;
    } else {
      X = `${cxy(true)}-overlay_w/2`;
      Y = `${cxy(false)}-overlay_h/2`;
    }
    return { label, x: X, y: Y };
  }

  function overlayOn(base: string, l: { label: string; x: string; y: string }, windows: [number, number][]): string {
    // half-open [a, b), judged half a frame inside each edge so a frame exactly on the boundary belongs to one side only
    const enable = windows.map(([a, b]) => `gte(t,${num(a - half)})*lt(t,${num(b - half)})`).join('+');
    const out = g.fresh('c');
    g.raw(`[${base}][${l.label}]overlay=x='${l.x}':y='${l.y}':format=gbrp:enable='${enable}'[${out}]`);
    return out;
  }

  /** A transition as one RGBA canvas stream: both clips drawn full-frame, then cross-faded by xfade. */
  function transitionStream(track: Track, tr: Transition, a: Clip, b: Clip, s: number, e: number): { label: string } | null {
    const ma = media.get(a.mediaId);
    const mb = media.get(b.mediaId);
    if (!ma || !mb) return null;
    const span = e - s;
    const mk = (clip: Clip, m: Media): string | null => {
      const l = layer({ clip, media: m, tl0: 0, dur: span / rate, clipAt: sec(clip.start) - sec(s), srcTicks: clip.sourceIn + Math.floor(((s - clip.start) * clip.speed.num) / clip.speed.den) });
      if (!l) return null;
      const canvas = g.fresh('tc');
      g.raw(`color=c=black@0:s=${W}x${H}:r=${fpsR}:d=${num(span / rate)},format=rgba[${canvas}]`);
      const out = g.fresh('t');
      g.raw(`[${canvas}][${l.label}]overlay=x='${l.x}':y='${l.y}':format=auto[${out}]`);
      return g.chain(out, [`fps=${fpsR}`, 'setpts=PTS-STARTPTS']);
    };
    void track;
    const la = mk(a, ma);
    const lb = mk(b, mb);
    if (!la || !lb) return null;
    const name = XFADE[tr.type] ?? 'fade';
    if (!XFADE[tr.type]) warnings.add(`Transition "${tr.type}" has no FFmpeg equivalent; a cross dissolve was used.`);
    if (tr.type === 'slide-left' || tr.type === 'push-right' || tr.type === 'iris' || tr.type === 'zoom') warnings.add(`The FFmpeg engine draws "${transitionDef(tr.type)?.label ?? tr.type}" slightly differently from the monitor.`);
    const out = g.fresh('x');
    g.raw(`[${la}][${lb}]xfade=transition=${name}:duration=${num(span / rate)}:offset=0[${out}]`);
    const shifted = g.chain(out, [`setpts=PTS-STARTPTS+${num(sec(s))}/TB`]);
    return { label: shifted };
  }

  for (const track of seq.tracks) {
    if (track.kind !== 'video' || track.muted) continue;
    const items = trackItems(track).filter((i): i is Clip => isClip(i) && i.enabled);
    // spans taken over by a transition: [clipId → windows to cut out]
    const cut = new Map<string, [number, number][]>();
    const spans: { tr: Transition; a: Clip; b: Clip; s: number; e: number }[] = [];
    for (const tr of track.transitions) {
      const a = track.items[tr.betweenClipIds[0]];
      const b = track.items[tr.betweenClipIds[1]];
      if (!a || !b || !isClip(a) || !isClip(b) || !a.enabled || !b.enabled) continue;
      const [s, e] = transitionSpan(itemEnd(a), tr.duration, tr.alignment);
      if (e <= from || s >= to || e <= s) continue;
      spans.push({ tr, a, b, s: Math.max(s, from), e: Math.min(e, to) });
      for (const c of [a, b]) cut.set(c.id, [...(cut.get(c.id) ?? []), [s, e]]);
    }
    for (const clip of items) {
      const start = clip.start;
      const end = itemEnd(clip);
      if (end <= from || start >= to) continue;
      const m = media.get(clip.mediaId);
      if (!m || m.missing) {
        warnings.add(`Media for "${clip.name ?? clip.id}" is missing; the clip is skipped.`);
        continue;
      }
      // visible parts of the clip: its range inside [from, to) minus the transition spans
      let windows: [number, number][] = [[Math.max(start, from), Math.min(end, to)]];
      for (const [cs, ce] of cut.get(clip.id) ?? []) windows = subtract(windows, cs, ce);
      if (!windows.length) continue;
      const ws = windows[0]![0];
      const we = windows[windows.length - 1]![1];
      const l = layer({ clip, media: m, tl0: sec(ws), dur: (we - ws) / rate, clipAt: sec(start), srcTicks: clip.sourceIn + Math.floor(((ws - start) * clip.speed.num) / clip.speed.den) });
      if (!l) continue;
      cur = overlayOn(cur, l, windows.map(([a, b]) => [sec(a), sec(b)] as [number, number]));
    }
    for (const { tr, a, b, s, e } of spans) {
      const t = transitionStream(track, tr, a, b, s, e);
      if (!t) continue;
      const out = g.fresh('c');
      g.raw(`[${cur}][${t.label}]overlay=x=0:y=0:format=gbrp:enable='gte(t,${num(sec(s) - half)})*lt(t,${num(sec(e) - half)})'[${out}]`);
      cur = out;
    }
  }

  if (input.assPath) cur = g.chain(cur, [`ass=filename='${input.assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`]);
  // RGB → Rec.709 limited range, the way every player expects HD video
  const out = g.chain(cur, [`scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int`, `format=${input.pixFmt}`], 'vout');
  return { inputs, graph: g.toString(), out, warnings: [...warnings], frames, fps, fpsRational: fpsR };
}
