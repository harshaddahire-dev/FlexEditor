export interface TransitionDef {
  type: string;
  label: string;
  /** Default length in seconds. */
  duration: number;
  /**
   * GLSL ES 3.00 body: `vec4 transition(vec2 uv)` using `getFromColor(uv)`, `getToColor(uv)` and `progress` (0→1) —
   * the gl-transitions convention, so more can be dropped in. Colours are premultiplied.
   */
  glsl: string;
}

/** Built-in transitions, drawn between two touching clips (or applied as a fade at a clip edge). */
export const TRANSITIONS: TransitionDef[] = [
  { type: 'dissolve', label: 'Cross dissolve', duration: 1, glsl: 'vec4 transition(vec2 uv) { return mix(getFromColor(uv), getToColor(uv), progress); }' },
  {
    type: 'dip-black',
    label: 'Dip to black',
    duration: 1,
    glsl: 'vec4 transition(vec2 uv) { float p = progress * 2.0; return progress < 0.5 ? mix(getFromColor(uv), vec4(0.0, 0.0, 0.0, 1.0), p) : mix(vec4(0.0, 0.0, 0.0, 1.0), getToColor(uv), p - 1.0); }',
  },
  {
    type: 'dip-white',
    label: 'Dip to white',
    duration: 1,
    glsl: 'vec4 transition(vec2 uv) { float p = progress * 2.0; return progress < 0.5 ? mix(getFromColor(uv), vec4(1.0), p) : mix(vec4(1.0), getToColor(uv), p - 1.0); }',
  },
  { type: 'wipe-left', label: 'Wipe left', duration: 0.8, glsl: 'vec4 transition(vec2 uv) { float edge = 1.0 - progress; return uv.x > edge ? getToColor(uv) : getFromColor(uv); }' },
  { type: 'wipe-right', label: 'Wipe right', duration: 0.8, glsl: 'vec4 transition(vec2 uv) { return uv.x < progress ? getToColor(uv) : getFromColor(uv); }' },
  { type: 'wipe-up', label: 'Wipe up', duration: 0.8, glsl: 'vec4 transition(vec2 uv) { return uv.y > 1.0 - progress ? getToColor(uv) : getFromColor(uv); }' },
  { type: 'wipe-down', label: 'Wipe down', duration: 0.8, glsl: 'vec4 transition(vec2 uv) { return uv.y < progress ? getToColor(uv) : getFromColor(uv); }' },
  {
    type: 'slide-left',
    label: 'Slide left',
    duration: 0.8,
    glsl: 'vec4 transition(vec2 uv) { vec2 s = vec2(progress, 0.0); return uv.x > 1.0 - progress ? getToColor(uv - vec2(1.0 - progress, 0.0)) : getFromColor(uv); }',
  },
  {
    type: 'push-left',
    label: 'Push left',
    duration: 0.8,
    glsl: 'vec4 transition(vec2 uv) { return uv.x + progress < 1.0 ? getFromColor(uv + vec2(progress, 0.0)) : getToColor(uv - vec2(1.0 - progress, 0.0)); }',
  },
  {
    type: 'push-right',
    label: 'Push right',
    duration: 0.8,
    glsl: 'vec4 transition(vec2 uv) { return uv.x - progress > 0.0 ? getFromColor(uv - vec2(progress, 0.0)) : getToColor(uv + vec2(1.0 - progress, 0.0)); }',
  },
  {
    type: 'zoom',
    label: 'Zoom',
    duration: 0.9,
    glsl: 'vec4 transition(vec2 uv) { vec2 c = vec2(0.5); float z = 1.0 + progress * 0.6; vec4 a = getFromColor(c + (uv - c) / z); return mix(a, getToColor(uv), smoothstep(0.35, 0.85, progress)); }',
  },
  {
    type: 'iris',
    label: 'Iris',
    duration: 0.9,
    glsl: 'vec4 transition(vec2 uv) { float d = distance(uv * vec2(1.7778, 1.0), vec2(0.8889, 0.5)); return d < progress * 1.1 ? getToColor(uv) : getFromColor(uv); }',
  },
];

const byType = new Map(TRANSITIONS.map((t) => [t.type, t]));
export const transitionDef = (type: string): TransitionDef | undefined => byType.get(type);
