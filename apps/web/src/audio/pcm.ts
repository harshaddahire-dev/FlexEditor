/** Header facts of a PCM WAV file. */
export interface WavInfo {
  channels: number;
  sampleRate: number;
  /** Byte offset of the first sample. */
  dataOffset: number;
  /** Sample frames in the file. */
  frames: number;
}

/** Parse the chunk list of a WAV header (RIFF/WAVE, `fmt `, optional LIST…, `data`). Only 16-bit PCM is supported. */
export function parseWavHeader(buf: ArrayBuffer): WavInfo {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');
  let channels = 0;
  let sampleRate = 0;
  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      const format = v.getUint16(o + 8, true);
      channels = v.getUint16(o + 10, true);
      sampleRate = v.getUint32(o + 12, true);
      const bits = v.getUint16(o + 22, true);
      const extensible = format === 0xfffe;
      if ((format !== 1 && !extensible) || bits !== 16) throw new Error(`Unsupported audio proxy (format ${format}, ${bits}-bit): expected 16-bit PCM.`);
    } else if (id === 'data') {
      if (!channels) throw new Error('WAV data chunk before fmt chunk.');
      return { channels, sampleRate, dataOffset: o + 8, frames: Math.floor(size / (2 * channels)) };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('WAV header has no data chunk (is it larger than the header probe?).');
}

const BLOCK_FRAMES = 1 << 17; // 2.7 s at 48 kHz
const MAX_BLOCKS = 24;

/**
 * Random access to a 16-bit PCM WAV over HTTP Range requests. Audio is read in fixed blocks, converted to float,
 * and kept in a small LRU, so a one-hour proxy costs memory for seconds, not hours. Reads outside the file are
 * silence.
 */
export class PcmSource {
  private readonly blocks = new Map<number, Promise<Float32Array[]>>();

  private constructor(
    private readonly url: string,
    readonly info: WavInfo,
  ) {}

  static async open(url: string): Promise<PcmSource> {
    const res = await fetch(url, { headers: { Range: 'bytes=0-8191' } });
    if (res.status !== 206 && res.status !== 200) throw new Error(`Could not read audio proxy (${res.status}).`);
    const head = await res.arrayBuffer();
    const info = parseWavHeader(head.slice(0, Math.min(head.byteLength, 8192)));
    return new PcmSource(url, info);
  }

  get channels(): number {
    return this.info.channels;
  }
  get sampleRate(): number {
    return this.info.sampleRate;
  }
  get frames(): number {
    return this.info.frames;
  }

  private block(i: number): Promise<Float32Array[]> {
    const hit = this.blocks.get(i);
    if (hit) {
      this.blocks.delete(i); // refresh LRU order
      this.blocks.set(i, hit);
      return hit;
    }
    const { channels, dataOffset, frames } = this.info;
    const first = i * BLOCK_FRAMES;
    const count = Math.min(BLOCK_FRAMES, frames - first);
    const p = (async () => {
      const lo = dataOffset + first * 2 * channels;
      const hi = lo + count * 2 * channels - 1;
      const res = await fetch(this.url, { headers: { Range: `bytes=${lo}-${hi}` } });
      if (res.status !== 206 && res.status !== 200) throw new Error(`Could not read audio proxy (${res.status}).`);
      let bytes = await res.arrayBuffer();
      if (res.status === 200) bytes = bytes.slice(lo, hi + 1); // server ignored Range
      const s16 = new Int16Array(bytes.slice(0, count * 2 * channels));
      const out = Array.from({ length: channels }, () => new Float32Array(count));
      for (let f = 0; f < count; f++) for (let c = 0; c < channels; c++) out[c]![f] = s16[f * channels + c]! / 32768;
      return out;
    })();
    this.blocks.set(i, p);
    p.catch(() => this.blocks.delete(i));
    while (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value as number);
    return p;
  }

  /** Samples for frames `[from, to)` of every channel; frames outside the file are zero. */
  async read(from: number, to: number): Promise<Float32Array[]> {
    const n = Math.max(0, to - from);
    const out = Array.from({ length: this.channels }, () => new Float32Array(n));
    const lo = Math.max(0, from);
    const hi = Math.min(this.frames, to);
    if (hi <= lo) return out;
    for (let b = Math.floor(lo / BLOCK_FRAMES); b <= Math.floor((hi - 1) / BLOCK_FRAMES); b++) {
      const data = await this.block(b);
      const bs = b * BLOCK_FRAMES;
      const s = Math.max(lo, bs);
      const e = Math.min(hi, bs + BLOCK_FRAMES);
      for (let c = 0; c < this.channels; c++) out[c]!.set(data[c]!.subarray(s - bs, e - bs), s - from);
    }
    return out;
  }
}
