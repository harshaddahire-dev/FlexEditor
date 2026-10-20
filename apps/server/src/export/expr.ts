import { type Keyframe, evaluateKeyframes } from '@cutroom/core';

/** Decimal with enough precision for sub-sample times, no exponent (FFmpeg's parser dislikes `1e-7`). */
export const num = (x: number): string => {
  if (!Number.isFinite(x)) return '0';
  const s = x.toFixed(9).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
};

interface Piece {
  /** Segment end, in seconds from the clip start. */
  end: number;
  v0: number;
  v1: number;
  t0: number;
}

const SAMPLES = 6;

/**
 * A keyframed property as an FFmpeg expression of `t` (timeline seconds): piecewise linear, with curved segments
 * sampled finely enough (6 pieces) that the result is visually the monitor's curve. `clipStart` is where the clip begins
 * on the same clock as `t`; `toValue` maps the stored value (e.g. degrees to radians).
 */
export function keyframeExpr(kfs: Keyframe[], fallback: number, rate: number, clipStart: number, toValue: (v: number) => number = (v) => v): string {
  if (!kfs.length) return num(toValue(fallback));
  const sorted = [...kfs].sort((a, b) => a.time - b.time);
  const val = (rel: number) => toValue(evaluateKeyframes(sorted, rel, fallback));
  const pieces: Piece[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const t0 = a.time / rate;
    const t1 = b.time / rate;
    if (a.interpolation === 'hold') {
      pieces.push({ t0, end: t1, v0: toValue(a.value), v1: toValue(a.value) });
      continue;
    }
    const n = a.interpolation === 'linear' ? 1 : SAMPLES;
    for (let k = 0; k < n; k++) {
      const p0 = k / n;
      const p1 = (k + 1) / n;
      const r0 = a.time + (b.time - a.time) * p0;
      const r1 = a.time + (b.time - a.time) * p1;
      pieces.push({ t0: r0 / rate, end: r1 / rate, v0: val(r0), v1: a.interpolation === 'linear' ? toValue(b.value) : val(r1) });
    }
  }
  const first = toValue(sorted[0]!.value);
  const last = toValue(sorted[sorted.length - 1]!.value);
  const rel = `(t-${num(clipStart)})`;
  let out = num(last);
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i]!;
    const lerp = p.v0 === p.v1 ? num(p.v0) : `${num(p.v0)}+(${num(p.v1 - p.v0)})*(${rel}-${num(p.t0)})/${num(p.end - p.t0)}`;
    out = `if(lt(${rel},${num(p.end)}),${lerp},${out})`;
  }
  return pieces.length ? `if(lt(${rel},${num(sorted[0]!.time / rate)}),${num(first)},${out})` : num(last);
}

/** Escape a filtergraph option value (commas and colons inside expressions are separators otherwise). */
export const q = (expr: string): string => `'${expr.replace(/'/g, "\\'")}'`;
