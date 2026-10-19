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
