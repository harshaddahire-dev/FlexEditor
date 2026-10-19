import { transitionDef } from '@cutroom/core';
import type { Affine } from './layers';

export type Drawable = VideoFrame | ImageBitmap | HTMLCanvasElement;

/** One effect pass for a layer: the effect type and its parameters already resolved at this instant. */
export interface EffectPass {
  type: string;
  params: Record<string, number>;
}

export interface Layer {
  source: Drawable;
  /** Bumped when a canvas source was redrawn (frames and bitmaps are immutable, so identity is enough for them). */
  version?: number;
  srcW: number;
  srcH: number;
  matrix: Affine;
  opacity: number;
  /** Fractions of the source trimmed from each side. */
  crop: { left: number; right: number; top: number; bottom: number };
  effects?: EffectPass[];
  /** Source pixels per sequence pixel: converts px-valued effect parameters (blur radius, mosaic size). */
  pixelScale?: number;
}

export type RenderItem = { kind: 'layer'; layer: Layer } | { kind: 'transition'; type: string; progress: number; from: Layer; to: Layer };

const LAYER_VERT = `#version 300 es
in vec2 aUv;
uniform vec3 uRow0; // x = a·u + c·v + e
uniform vec3 uRow1; // y = b·u + d·v + f
uniform vec2 uSize;
uniform vec4 uCrop; // u0 v0 u1 v1
out vec2 vUv;
void main() {
  vec2 uv = mix(uCrop.xy, uCrop.zw, aUv);
  vec2 p = vec2(uRow0.x * uv.x + uRow0.y * uv.y + uRow0.z, uRow1.x * uv.x + uRow1.y * uv.y + uRow1.z);
  gl_Position = vec4(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0, 0.0, 1.0);
  vUv = uv;
}`;

const LAYER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUv);
  outColor = vec4(c.rgb * c.a * uOpacity, c.a * uOpacity); // premultiplied
}`;

/** Full-screen pass: clip space = uv·2−1, so a pass writes the texel row it reads (orientation is preserved). */
const PASS_VERT = `#version 300 es
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aUv * 2.0 - 1.0, 0.0, 1.0);
}`;

const EFFECT_HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uP[8];
out vec4 o;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** Fragment bodies of the built-in effects (`uP[i]` are the parameters in registry order). */
const EFFECT_BODY: Record<string, string> = {
  color: `
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 rgb = c.rgb * exp2(uP[0]) + uP[1];
  rgb = (rgb - 0.5) * (1.0 + uP[2]) + 0.5;
  rgb = mix(vec3(luma(rgb)), rgb, uP[3]);
  rgb += vec3(uP[4] * 0.1, uP[5] * 0.06, -uP[4] * 0.1) + vec3(-uP[5] * 0.03, 0.0, -uP[5] * 0.03);
  o = vec4(clamp(rgb, 0.0, 1.0), c.a);
}`,
  look: `
vec3 grade(vec3 c, int look) {
  float l = luma(c);
  if (look == 0) { c = pow(c, vec3(0.92)) * vec3(1.07, 1.0, 0.9); c = (c - 0.5) * 1.08 + 0.5; }
  else if (look == 1) { vec3 shadow = vec3(0.0, 0.32, 0.42); vec3 high = vec3(1.0, 0.62, 0.28); c = mix(c, c * mix(shadow * 2.4, high * 1.35, smoothstep(0.15, 0.85, l)), 0.75); c = (c - 0.5) * 1.12 + 0.5; }
  else if (look == 2) { c = mix(vec3(l), c, 0.45); c = (c - 0.5) * 1.35 + 0.5; }
  else if (look == 3) { c = vec3((l - 0.5) * 1.3 + 0.5); }
  else { c = mix(vec3(l), c, 0.8) * 0.9 + 0.08; }
  return c;
}
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 g = clamp(grade(c.rgb, int(uP[0] + 0.5)), 0.0, 1.0);
  o = vec4(mix(c.rgb, g, uP[1]), c.a);
}`,
  blur: `
void main() {
  float radius = uP[0];
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  float step_ = max(radius / 6.0, 0.001);
  float sigma = max(radius / 2.0, 0.001);
  for (int i = -6; i <= 6; i++) {
    float x = float(i) * step_;
    float w = exp(-0.5 * (x * x) / (sigma * sigma));
    acc += texture(uTex, vUv + uDir * uTexel * x) * w;
    wsum += w;
  }
  o = acc / wsum;
}`,
  sharpen: `
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 b = (texture(uTex, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uTex, vUv - vec2(uTexel.x, 0.0)).rgb + texture(uTex, vUv + vec2(0.0, uTexel.y)).rgb + texture(uTex, vUv - vec2(0.0, uTexel.y)).rgb) * 0.25;
  o = vec4(clamp(c.rgb + (c.rgb - b) * uP[0] * 2.0, 0.0, 1.0), c.a);
}`,
  vignette: `
void main() {
  vec4 c = texture(uTex, vUv);
  float d = distance(vUv, vec2(0.5)) * 1.4142;
  float edge = 1.0 - uP[1] * 0.9;
  float v = smoothstep(edge, 1.0, d);
  o = vec4(c.rgb * (1.0 - v * uP[0]), c.a);
}`,
  sepia: `
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 s = vec3(dot(c.rgb, vec3(0.393, 0.769, 0.189)), dot(c.rgb, vec3(0.349, 0.686, 0.168)), dot(c.rgb, vec3(0.272, 0.534, 0.131)));
  o = vec4(mix(c.rgb, clamp(s, 0.0, 1.0), uP[0]), c.a);
}`,
  pixelate: `
void main() {
  vec2 cell = max(uP[0], 1.0) * uTexel;
  o = texture(uTex, (floor(vUv / cell) + 0.5) * cell);
}`,
};

/** Passes an effect needs: separable blur runs horizontally, then vertically. */
const PASSES: Record<string, [number, number][]> = { blur: [[1, 0], [0, 1]] };

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

/**
 * WebGL2 compositor. Layers (decoded frames, stills, caption canvases) are drawn bottom-to-top onto a sequence-sized
 * canvas. A layer with effects first runs through shader passes into off-screen targets; a transition draws its two
 * clips into targets and blends them with a gl-transitions style shader. A texture slot skips re-uploading when it is
 * handed the same source (and version) again — which is every repaint while paused.
 */
export class Compositor {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly layerProg: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly lu: Record<string, WebGLUniformLocation | null> = {};
  private slots: { tex: WebGLTexture; source: Drawable | null; version: number | undefined }[] = [];
  private slotIndex = 0;
  private readonly effectProgs = new Map<string, { prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null> } | null>();
  private readonly transProgs = new Map<string, { prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null> } | null>();
  private targets = new Map<string, Target>();

  constructor(width: number, height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.layerProg = this.program(LAYER_VERT, LAYER_FRAG);
    for (const n of ['uRow0', 'uRow1', 'uSize', 'uCrop', 'uTex', 'uOpacity']) this.lu[n] = gl.getUniformLocation(this.layerProg, n);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private program(vs: string, fs: string): WebGLProgram {
    const { gl } = this;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aUv');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program error: ${gl.getProgramInfoLog(p)}`);
    return p;
  }

  get width(): number {
    return this.canvas.width;
  }
  get height(): number {
    return this.canvas.height;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    for (const t of this.targets.values()) this.freeTarget(t);
    this.targets.clear();
  }

  /* ----------------------------------------------------------- textures & targets */

  private slot() {
    const { gl } = this;
    const i = this.slotIndex++;
    while (this.slots.length <= i) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.slots.push({ tex, source: null, version: undefined });
    }
    return this.slots[i]!;
  }

  private upload(l: Layer): WebGLTexture {
    const { gl } = this;
    const slot = this.slot();
    gl.bindTexture(gl.TEXTURE_2D, slot.tex);
    if (slot.source !== l.source || slot.version !== l.version) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, l.source);
      slot.source = l.source;
      slot.version = l.version;
    }
    return slot.tex;
  }

  /** Off-screen render target by name (re-created when its size changes). */
  private target(name: string, w: number, h: number): Target {
    const { gl } = this;
    const hit = this.targets.get(name);
    if (hit && hit.w === w && hit.h === h) return hit;
    if (hit) this.freeTarget(hit);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { tex, fbo, w, h };
    this.targets.set(name, t);
    return t;
  }

  private freeTarget(t: Target): void {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  private bind(t: Target | null, w: number, h: number): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, w, h);
  }

  /* --------------------------------------------------------------------- effects */

  private effectProgram(type: string) {
    if (this.effectProgs.has(type)) return this.effectProgs.get(type)!;
    const body = EFFECT_BODY[type];
    let entry: { prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null> } | null = null;
    if (body) {
      const prog = this.program(PASS_VERT, EFFECT_HEAD + body);
      const u: Record<string, WebGLUniformLocation | null> = {};
      for (const n of ['uTex', 'uTexel', 'uDir', 'uP']) u[n] = this.gl.getUniformLocation(prog, n);
      entry = { prog, u };
    }
    this.effectProgs.set(type, entry);
    return entry;
  }

  /** Run a layer's effects over its source; returns the texture holding the result (the source texture if none apply). */
  private applyEffects(src: WebGLTexture, l: Layer): WebGLTexture {
    const { gl } = this;
    const effects = (l.effects ?? []).filter((e) => this.effectProgram(e.type));
    if (!effects.length) return src;
    const scale = l.pixelScale ?? 1;
    let input = src;
    let flip = 0;
    gl.disable(gl.BLEND);
    for (const fx of effects) {
      const { prog, u } = this.effectProgram(fx.type)!;
      const keys = Object.keys(fx.params);
      const vals = new Float32Array(8);
      keys.forEach((k, i) => {
        if (i < 8) vals[i] = (fx.type === 'blur' && k === 'radius') || (fx.type === 'pixelate' && k === 'size') ? fx.params[k]! * scale : fx.params[k]!;
      });
      for (const dir of PASSES[fx.type] ?? [[0, 0]]) {
        const out = this.target(`fx${flip}_${l.srcW}x${l.srcH}`, l.srcW, l.srcH);
        flip ^= 1;
        this.bind(out, l.srcW, l.srcH);
        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, input);
        gl.uniform1i(u.uTex!, 0);
        gl.uniform2f(u.uTexel!, 1 / l.srcW, 1 / l.srcH);
        gl.uniform2f(u.uDir!, dir[0]!, dir[1]!);
        gl.uniform1fv(u.uP!, vals);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        input = out.tex;
      }
    }
    gl.enable(gl.BLEND);
    return input;
  }

  /* ----------------------------------------------------------------------- layers */

  private drawLayer(l: Layer, target: Target | null): void {
    const { gl, lu } = this;
    const src = this.upload(l);
    const tex = this.applyEffects(src, l);
    this.bind(target, this.canvas.width, this.canvas.height);
    gl.useProgram(this.layerProg);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(lu.uSize!, this.canvas.width, this.canvas.height);
    gl.uniform1i(lu.uTex!, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const [a, b, c, d, e, f] = l.matrix;
    gl.uniform3f(lu.uRow0!, a, c, e);
    gl.uniform3f(lu.uRow1!, b, d, f);
    gl.uniform4f(lu.uCrop!, l.crop.left, l.crop.top, 1 - l.crop.right, 1 - l.crop.bottom);
    gl.uniform1f(lu.uOpacity!, l.opacity);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* ------------------------------------------------------------------ transitions */

  private transitionProgram(type: string) {
    if (this.transProgs.has(type)) return this.transProgs.get(type)!;
    const def = transitionDef(type);
    let entry: { prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null> } | null = null;
    if (def) {
      const fs = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float progress;
out vec4 o;
vec4 getFromColor(vec2 uv) { return texture(uFrom, uv); }
vec4 getToColor(vec2 uv) { return texture(uTo, uv); }
${def.glsl}
void main() { o = transition(vUv); }`;
      const prog = this.program(PASS_VERT, fs);
      const u: Record<string, WebGLUniformLocation | null> = {};
      for (const n of ['uFrom', 'uTo', 'progress']) u[n] = this.gl.getUniformLocation(prog, n);
      entry = { prog, u };
    }
    this.transProgs.set(type, entry);
    return entry;
  }

  private drawTransition(item: Extract<RenderItem, { kind: 'transition' }>): void {
    const { gl } = this;
    const entry = this.transitionProgram(item.type);
    if (!entry) {
      // unknown transition: fall back to a plain cut to the incoming clip so nothing disappears
      this.drawLayer(item.progress < 0.5 ? item.from : item.to, null);
      return;
    }
    const w = this.canvas.width;
    const h = this.canvas.height;
    const A = this.target('tA', w, h);
    const B = this.target('tB', w, h);
    for (const [t, layer] of [[A, item.from], [B, item.to]] as const) {
      this.bind(t, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawLayer(layer, t);
    }
    this.bind(null, w, h);
    gl.useProgram(entry.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, B.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(entry.u.uFrom!, 0);
    gl.uniform1i(entry.u.uTo!, 1);
    gl.uniform1f(entry.u.progress!, Math.min(1, Math.max(0, item.progress)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Paint `items` (bottom first) over black. */
  render(items: readonly RenderItem[]): void {
    const { gl } = this;
    this.slotIndex = 0;
    this.bind(null, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const it of items) {
      if (it.kind === 'layer') this.drawLayer(it.layer, null);
      else this.drawTransition(it);
    }
  }

  /** RGBA of one sequence pixel from the last render (top-left origin). */
  readPixel(x: number, y: number): [number, number, number, number] {
    const out = new Uint8Array(4);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.readPixels(Math.round(x), this.canvas.height - 1 - Math.round(y), 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, out);
    return [out[0]!, out[1]!, out[2]!, out[3]!];
  }

  dispose(): void {
    this.slots.forEach((s) => this.gl.deleteTexture(s.tex));
    this.slots = [];
    for (const t of this.targets.values()) this.freeTarget(t);
    this.targets.clear();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
