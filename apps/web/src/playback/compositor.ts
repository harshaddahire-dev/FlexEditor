import type { Affine } from './layers';

export type Drawable = VideoFrame | ImageBitmap;

export interface Layer {
  source: Drawable;
  srcW: number;
  srcH: number;
  matrix: Affine;
  opacity: number;
  /** Fractions of the source trimmed from each side. */
  crop: { left: number; right: number; top: number; bottom: number };
}

const VERT = `#version 300 es
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

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUv);
  outColor = vec4(c.rgb * c.a * uOpacity, c.a * uOpacity); // premultiplied
}`;

/**
 * WebGL2 compositor: draws layers bottom-to-top onto a canvas the size of the sequence. Decoded VideoFrames are
 * uploaded straight to textures (the browser applies the frame's own colour matrix/range), and a slot skips the
 * upload when it is handed the same frame object it already holds — which is every repaint while paused.
 */
export class Compositor {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private slots: { tex: WebGLTexture; source: Drawable | null }[] = [];

  constructor(width: number, height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.prog = this.program();
    for (const n of ['uRow0', 'uRow1', 'uSize', 'uCrop', 'uTex', 'uOpacity']) this.u[n] = gl.getUniformLocation(this.prog, n);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aUv');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private program(): WebGLProgram {
    const { gl } = this;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAG));
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
  }

  private slot(i: number) {
    const { gl } = this;
    while (this.slots.length <= i) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.slots.push({ tex, source: null });
    }
    return this.slots[i]!;
  }

  /** Paint `layers` (bottom first) over black. */
  render(layers: readonly Layer[]): void {
    const { gl, u } = this;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(u.uSize!, this.canvas.width, this.canvas.height);
    gl.uniform1i(u.uTex!, 0);
    gl.activeTexture(gl.TEXTURE0);

    layers.forEach((l, i) => {
      const slot = this.slot(i);
      gl.bindTexture(gl.TEXTURE_2D, slot.tex);
      if (slot.source !== l.source) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, l.source);
        slot.source = l.source;
      }
      const [a, b, c, d, e, f] = l.matrix;
      gl.uniform3f(u.uRow0!, a, c, e);
      gl.uniform3f(u.uRow1!, b, d, f);
      gl.uniform4f(u.uCrop!, l.crop.left, l.crop.top, 1 - l.crop.right, 1 - l.crop.bottom);
      gl.uniform1f(u.uOpacity!, l.opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });
  }

  /** Forget cached uploads for frames that are about to be closed. */
  release(source: Drawable): void {
    for (const s of this.slots) if (s.source === source) s.source = null;
  }

  /** RGBA of one sequence pixel from the last render (top-left origin). */
  readPixel(x: number, y: number): [number, number, number, number] {
    const out = new Uint8Array(4);
    this.gl.readPixels(Math.round(x), this.canvas.height - 1 - Math.round(y), 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, out);
    return [out[0]!, out[1]!, out[2]!, out[3]!];
  }

  dispose(): void {
    this.slots.forEach((s) => this.gl.deleteTexture(s.tex));
    this.slots = [];
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
