import type { Keyframe } from './types';

/* ---------- cubic-bezier timing curves ---------- */

type Bezier = [number, number, number, number];

/** Curve for the segment leaving `k`. Defaults give a gentle ease-in-out (1/3 influence, zero slope). */
export function segmentBezier(k: Keyframe): Bezier {
  if (k.bezier) return k.bezier;
  return [k.easeOut ?? 1 / 3, 0, 1 - (k.easeIn ?? 1 / 3), 1];
}

function bez(a: number, b: number, u: number): number {
  // one coordinate of a cubic with P0 = 0 and P3 = 1:  3(1-u)²u·a + 3(1-u)u²·b + u³
  const v = 1 - u;
  return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
}

/** Solve x(u) = p for the curve parameter by bisection (monotone for x1,x2 in [0,1]). */
function solveU(x1: number, x2: number, p: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Eased progress for linear progress `p` in [0,1] along a bezier timing curve. */
export function easeBezier(c: Bezier, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return bez(c[1], c[3], solveU(c[0], c[2], p));
}

/* ---------- evaluation ---------- */

export function sortKeyframes(kfs: readonly Keyframe[]): Keyframe[] {
  return [...kfs].sort((a, b) => a.time - b.time);
}

/** Value of an animated property at clip-relative time `t` (holds first/last value outside the range). */
export function evaluateKeyframes(kfs: readonly Keyframe[], t: number, fallback: number): number {
  const n = kfs.length;
  if (n === 0) return fallback;
  const first = kfs[0]!;
  if (t <= first.time) return first.value;
  const last = kfs[n - 1]!;
  if (t >= last.time) return last.value;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid]!.time <= t) lo = mid;
    else hi = mid;
  }
  const a = kfs[lo]!;
  const b = kfs[hi]!;
  const p = (t - a.time) / (b.time - a.time);
  switch (a.interpolation) {
    case 'hold':
      return a.value;
    case 'linear':
      return a.value + (b.value - a.value) * p;
    case 'bezier':
      return a.value + (b.value - a.value) * easeBezier(segmentBezier(a), p);
  }
}

/* ---------- editing helpers used by split / trim / speed ---------- */

/** Split a bezier timing curve at linear progress `p` into two curves renormalised to the unit box. */
function splitBezier(c: Bezier, p: number): { left: Bezier; right: Bezier; yAt: number } {
  const u = solveU(c[0], c[2], p);
  // de Casteljau on P0=(0,0) P1=(c0,c1) P2=(c2,c3) P3=(1,1)
  const lerp = (a: number, b: number) => a + (b - a) * u;
  const p01x = lerp(0, c[0]);
  const p01y = lerp(0, c[1]);
  const p12x = lerp(c[0], c[2]);
  const p12y = lerp(c[1], c[3]);
  const p23x = lerp(c[2], 1);
  const p23y = lerp(c[3], 1);
  const p012x = lerp(p01x, p12x);
  const p012y = lerp(p01y, p12y);
  const p123x = lerp(p12x, p23x);
  const p123y = lerp(p12y, p23y);
  const mx = lerp(p012x, p123x);
  const my = lerp(p012y, p123y);
  const lx = mx || 1;
  const ly = my || 1;
  const rx = 1 - mx || 1;
  const ry = 1 - my || 1;
  return {
    left: [p01x / lx, p01y / ly, p012x / lx, p012y / ly],
    right: [(p123x - mx) / rx, (p123y - my) / ry, (p23x - mx) / rx, (p23y - my) / ry],
    yAt: my,
  };
}

/** Sub-curve covering linear progress [pa, pb] of a bezier timing curve, renormalised to the unit box. */
function sliceBezier(c: Bezier, pa: number, pb: number): Bezier {
  let curve = c;
  if (pb < 1) curve = splitBezier(curve, pb).left;
  const pa2 = pb < 1 ? pa / pb : pa;
  if (pa2 > 0) curve = splitBezier(curve, pa2).right;
  return curve;
}

/**
 * Keyframes for a clip that now covers the window [from, to] of the old clip's time (relative ticks),
 * re-based so `from` becomes 0. Boundary keyframes are inserted so the animation is unchanged inside the
 * window — exactly, including bezier segments that get cut by the window edge.
 */
export function windowKeyframes(kfs: readonly Keyframe[], from: number, to: number): Keyframe[] {
  if (kfs.length === 0) return [];
  const s = sortKeyframes(kfs);
  const first = s[0]!;
  const last = s[s.length - 1]!;
  // the whole window lies in a constant region
  if (from >= last.time) return [{ time: 0, value: last.value, interpolation: 'linear' }];
  if (to <= first.time) return [{ time: 0, value: first.value, interpolation: 'linear' }];

  /** `idx` is the original keyframe that owns the outgoing segment this entry starts (−1: none). */
  const entries: { idx: number; at: number; key: Keyframe }[] = [];

  if (from >= first.time) {
    let i = 0;
    while (i + 1 < s.length && s[i + 1]!.time <= from) i++;
    const owner = s[i]!;
    if (owner.time === from) entries.push({ idx: i, at: from, key: { ...owner, time: 0 } });
    else {
      const { time: _t, value: _v, ...rest } = owner;
      entries.push({ idx: i, at: from, key: { ...rest, time: 0, value: evaluateKeyframes(s, from, owner.value) } });
    }
  }
  s.forEach((k, i) => {
    if (k.time > from && k.time < to) entries.push({ idx: i, at: k.time, key: { ...k, time: k.time - from } });
  });
  if (to <= last.time) {
    const exact = s.findIndex((k) => k.time === to);
    if (exact >= 0) entries.push({ idx: exact, at: to, key: { ...s[exact]!, time: to - from } });
    else entries.push({ idx: -1, at: to, key: { time: to - from, value: evaluateKeyframes(s, to, last.value), interpolation: 'linear' } });
  }

  // Cut each bezier segment down to the part that is actually inside the window.
  for (let j = 0; j < entries.length - 1; j++) {
    const e = entries[j]!;
    const owner = e.idx >= 0 ? s[e.idx] : undefined;
    const next = e.idx >= 0 ? s[e.idx + 1] : undefined;
    if (!owner || !next || e.key.interpolation !== 'bezier') continue;
    const len = next.time - owner.time;
    const pa = (e.at - owner.time) / len;
    const pb = Math.min(1, (entries[j + 1]!.at - owner.time) / len);
    if (pa > 0 || pb < 1) e.key = { ...e.key, bezier: sliceBezier(segmentBezier(owner), pa, pb) };
  }
  return entries.map((e) => e.key);
}

/** Scale keyframe times by num/den (used when a clip's speed changes), rounding to whole ticks. */
export function scaleKeyframeTimes(kfs: readonly Keyframe[], num: number, den: number): Keyframe[] {
  return kfs.map((k) => ({ ...k, time: Math.round((k.time * num) / den) }));
}
