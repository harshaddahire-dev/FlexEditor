import { evaluateKeyframes } from './edit/keyframes';
import type { Clip, EffectInstance, ParamValue } from './edit/types';

export interface ParamDef {
  key: string;
  label: string;
  /** `choice` params hold an option index (stored as a number so they can be animated or scrubbed like any other). */
  kind?: 'number' | 'choice';
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  options?: string[];
}

export interface EffectDef {
  type: string;
  label: string;
  group: 'Color' | 'Look' | 'Blur & sharpen' | 'Stylize';
  description: string;
  params: ParamDef[];
}

const num = (key: string, label: string, min: number, max: number, def: number, step = 0.01, unit?: string): ParamDef => ({ key, label, min, max, step, default: def, ...(unit ? { unit } : {}) });

/** Built-in effects. The compositor implements each as a shader pass; the Inspector and the agents read this table. */
export const EFFECTS: EffectDef[] = [
  {
    type: 'color',
    label: 'Color',
    group: 'Color',
    description: 'Exposure, brightness, contrast, saturation and white balance.',
    params: [num('exposure', 'Exposure', -3, 3, 0, 0.05, 'EV'), num('brightness', 'Brightness', -1, 1, 0), num('contrast', 'Contrast', -1, 1, 0), num('saturation', 'Saturation', 0, 2, 1), num('temperature', 'Temperature', -1, 1, 0), num('tint', 'Tint', -1, 1, 0)],
  },
  {
    type: 'look',
    label: 'Look',
    group: 'Look',
    description: 'A graded look: warm film, teal & orange, bleach bypass, noir, faded.',
    params: [{ key: 'look', label: 'Look', kind: 'choice', min: 0, max: 4, step: 1, default: 0, options: ['Warm film', 'Teal & orange', 'Bleach bypass', 'Noir', 'Faded'] }, num('strength', 'Strength', 0, 1, 1)],
  },
  { type: 'blur', label: 'Gaussian blur', group: 'Blur & sharpen', description: 'Softens the picture.', params: [num('radius', 'Radius', 0, 60, 8, 0.5, 'px')] },
  { type: 'sharpen', label: 'Sharpen', group: 'Blur & sharpen', description: 'Increases edge contrast.', params: [num('amount', 'Amount', 0, 2, 0.6)] },
  { type: 'vignette', label: 'Vignette', group: 'Stylize', description: 'Darkens the edges.', params: [num('amount', 'Amount', 0, 1, 0.5), num('softness', 'Softness', 0.05, 1, 0.5)] },
  { type: 'sepia', label: 'Sepia', group: 'Stylize', description: 'Old-photograph tone.', params: [num('amount', 'Amount', 0, 1, 1)] },
  { type: 'pixelate', label: 'Pixelate', group: 'Stylize', description: 'Blocky mosaic.', params: [num('size', 'Block size', 1, 64, 12, 1, 'px')] },
];

const byType = new Map(EFFECTS.map((e) => [e.type, e]));
export const effectDef = (type: string): EffectDef | undefined => byType.get(type);

export function defaultParams(type: string): Record<string, ParamValue> {
  return Object.fromEntries((effectDef(type)?.params ?? []).map((p) => [p.key, p.default]));
}

/** Clamp a value into a parameter's range (choices are rounded to a whole option). */
export function clampParam(def: ParamDef, v: number): number {
  const c = Math.min(def.max, Math.max(def.min, v));
  return def.kind === 'choice' ? Math.round(c) : c;
}

/** Effect parameters at clip-relative time `rel`: stored values, overridden by `effect:<id>.<key>` keyframes. */
export function resolveEffectParams(effect: EffectInstance, clip: Pick<Clip, 'keyframes'>, rel: number): Record<string, number> {
  const def = effectDef(effect.type);
  const out: Record<string, number> = {};
  for (const p of def?.params ?? []) {
    const stored = effect.params[p.key];
    const base = typeof stored === 'number' ? stored : p.default;
    const kf = clip.keyframes[`effect:${effect.id}.${p.key}`];
    out[p.key] = clampParam(p, kf?.length ? evaluateKeyframes(kf, rel, base) : base);
  }
  return out;
}

/** Why an effect request is invalid, or null. Used by the Inspector and the agent tools before they build ops. */
export function validateEffect(type: string, params: Record<string, unknown> = {}): string | null {
  const def = effectDef(type);
  if (!def) return `Unknown effect "${type}". Available: ${EFFECTS.map((e) => e.type).join(', ')}.`;
  for (const [k, v] of Object.entries(params)) {
    const p = def.params.find((x) => x.key === k);
    if (!p) return `${def.label} has no parameter "${k}". Parameters: ${def.params.map((x) => x.key).join(', ')}.`;
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${def.label} ${k} must be a number.`;
    if (v < p.min || v > p.max) return `${def.label} ${k} must be between ${p.min} and ${p.max}.`;
  }
  return null;
}
