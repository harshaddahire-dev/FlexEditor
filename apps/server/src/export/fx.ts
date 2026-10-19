import { num } from './expr';
import type { Graph } from './graph';

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** Saturation-and-gain as a channel mixer: rows of `out = gain · (s·I + (1-s)·1·lumaᵀ) · rgb`. */
function mixer(gain: number, s: number): string {
  const ch = ['r', 'g', 'b'] as const;
  const parts: string[] = [];
  ch.forEach((o, i) => ch.forEach((c, j) => parts.push(`${o}${c}=${num(gain * ((i === j ? s : 0) + (1 - s) * LUMA[j]!))}`)));
  return `colorchannelmixer=${parts.join(':')}`;
}

/** Per-channel offset in 0..1 units, clipped. */
function offsets(r: number, g: number, b: number): string | null {
  if (!r && !g && !b) return null;
  const f = (o: number) => `clip(val+${num(o)}*maxval,0,maxval)`;
  return `lutrgb=r='${f(r)}':g='${f(g)}':b='${f(b)}'`;
}

export interface FxResult {
  /** Output label. */
  out: string;
  /** The FFmpeg version only approximates the monitor's shader. */
  approximate: boolean;
}

/**
 * One built-in effect as FFmpeg filters, mirroring the compositor's shaders. `scale` converts the effect's
 * sequence-pixel parameters to source pixels (the same `pixelScale` the monitor uses). Most are exact; vignette,
 * teal & orange and pixelate are close but not identical, and say so.
 */
export function effectGraph(g: Graph, input: string, type: string, p: Record<string, number>, scale: number): FxResult {
  switch (type) {
    case 'color': {
      const gain = 2 ** (p.exposure ?? 0) * (1 + (p.contrast ?? 0));
      const k = 1 + (p.contrast ?? 0);
      const o2 = ((p.brightness ?? 0) - 0.5) * k + 0.5;
      const T = p.temperature ?? 0;
      const Tn = p.tint ?? 0;
      const steps = [mixer(gain, p.saturation ?? 1), offsets(o2 + 0.1 * T - 0.03 * Tn, o2 + 0.06 * Tn, o2 - 0.1 * T - 0.03 * Tn)].filter((x): x is string => !!x);
      return { out: g.chain(input, steps), approximate: false };
    }
    case 'look': {
      const look = Math.round(p.look ?? 0);
      const strength = Math.max(0, Math.min(1, p.strength ?? 1));
      const lut = (gains: [number, number, number], pow: number, k: number) => {
        const f = (gn: number) => `clip((pow(val/maxval,${num(pow)})*${num(gn)}-0.5)*${num(k)}+0.5,0,1)*maxval`;
        return `lutrgb=r='${f(gains[0])}':g='${f(gains[1])}':b='${f(gains[2])}'`;
      };
      let steps: string[];
      let approximate = false;
      switch (look) {
        case 0: steps = [lut([1.07, 1, 0.9], 0.92, 1.08)]; break;
        case 1: steps = ['colorbalance=rs=-0.16:gs=0.04:bs=0.14:rh=0.2:gh=0.02:bh=-0.16', lut([1, 1, 1], 1, 1.12)]; approximate = true; break;
        case 2: steps = [mixer(1.35, 0.45), offsets(0.5 - 0.675, 0.5 - 0.675, 0.5 - 0.675)!]; break;
        case 3: steps = [`colorchannelmixer=${(['r', 'g', 'b'] as const).flatMap((o) => (['r', 'g', 'b'] as const).map((c, j) => `${o}${c}=${num(1.3 * LUMA[j]!)}`)).join(':')}`, offsets(-0.15, -0.15, -0.15)!]; break;
        default: steps = [mixer(0.9, 0.8), offsets(0.08, 0.08, 0.08)!];
      }
      if (strength >= 0.999) return { out: g.chain(input, steps), approximate };
      // mix(original, graded, strength): graded over original at that opacity
      const a = g.fresh('o');
      const b = g.fresh('o');
      g.raw(`[${input}]split[${a}][${b}]`);
      const graded = g.chain(b, steps);
      const out = g.fresh();
      g.raw(`[${a}][${graded}]blend=all_mode=normal:all_opacity=${num(strength)}[${out}]`);
      return { out, approximate };
    }
    case 'blur': {
      const sigma = ((p.radius ?? 0) * scale) / 2;
      return { out: sigma < 0.05 ? input : g.chain(input, [`gblur=sigma=${num(sigma)}:steps=2`]), approximate: false };
    }
    case 'sharpen': {
      const a = (p.amount ?? 0) * 2;
      return { out: a <= 0 ? input : g.chain(input, [`unsharp=lx=3:ly=3:la=${num(Math.min(5, a))}:cx=3:cy=3:ca=0`]), approximate: false };
    }
    case 'vignette': {
      const amount = p.amount ?? 0;
      return { out: amount <= 0 ? input : g.chain(input, [`vignette=angle=${num(Math.max(0.05, Math.min(Math.PI / 2.2, amount * 1.1)))}:mode=forward:eval=init`]), approximate: true };
    }
    case 'sepia': {
      const a = Math.max(0, Math.min(1, p.amount ?? 0));
      if (a <= 0) return { out: input, approximate: false };
      const S = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
      const ch = ['r', 'g', 'b'] as const;
      const parts = ch.flatMap((o, i) => ch.map((c, j) => `${o}${c}=${num((i === j ? 1 - a : 0) + a * S[i]![j]!)}`));
      return { out: g.chain(input, [`colorchannelmixer=${parts.join(':')}`]), approximate: false };
    }
    case 'pixelate': {
      const s = Math.max(1, Math.round((p.size ?? 1) * scale));
      return { out: s <= 1 ? input : g.chain(input, [`pixelize=w=${s}:h=${s}`]), approximate: true };
    }
    default:
      return { out: input, approximate: true };
  }
}
