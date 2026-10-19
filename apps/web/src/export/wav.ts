/** 32-bit float stereo WAV header for `frames` sample frames (the whole file's size is known up front, so it can be streamed). */
export function wavHeader(frames: number, sampleRate: number, channels = 2): Uint8Array {
  const bytesPerFrame = channels * 4;
  const data = frames * bytesPerFrame;
  const b = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  b.setUint32(4, 36 + data, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  b.setUint32(16, 16, true);
  b.setUint16(20, 3, true); // IEEE float
  b.setUint16(22, channels, true);
  b.setUint32(24, sampleRate, true);
  b.setUint32(28, sampleRate * bytesPerFrame, true);
  b.setUint16(32, bytesPerFrame, true);
  b.setUint16(34, 32, true);
  str(36, 'data');
  b.setUint32(40, data, true);
  return new Uint8Array(b.buffer);
}

/** Interleave an AudioBuffer's channels as little-endian float32. */
export function interleave(buf: Pick<AudioBuffer, 'length' | 'numberOfChannels' | 'getChannelData'>): Uint8Array {
  const n = buf.length;
  const ch = Math.min(2, buf.numberOfChannels);
  const out = new Float32Array(n * 2);
  const l = buf.getChannelData(0);
  const r = ch > 1 ? buf.getChannelData(1) : l;
  for (let i = 0; i < n; i++) {
    out[i * 2] = l[i]!;
    out[i * 2 + 1] = r[i]!;
  }
  return new Uint8Array(out.buffer);
}

/** IVF container header + per-frame header, so FFmpeg can read VP9 chunks from a plain byte stream. */
export function ivfHeader(width: number, height: number, fpsNum: number, fpsDen: number): Uint8Array {
  const b = new DataView(new ArrayBuffer(32));
  [...'DKIF'].forEach((c, i) => b.setUint8(i, c.charCodeAt(0)));
  b.setUint16(4, 0, true);
  b.setUint16(6, 32, true);
  [...'VP90'].forEach((c, i) => b.setUint8(8 + i, c.charCodeAt(0)));
  b.setUint16(12, width, true);
  b.setUint16(14, height, true);
  b.setUint32(16, fpsNum, true); // timebase denominator = frame rate numerator
  b.setUint32(20, fpsDen, true);
  b.setUint32(24, 0, true); // frame count: readers go on to EOF
  return new Uint8Array(b.buffer);
}

export function ivfFrame(data: Uint8Array, pts: number): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const b = new DataView(out.buffer);
  b.setUint32(0, data.byteLength, true);
  b.setUint32(4, pts >>> 0, true);
  b.setUint32(8, Math.floor(pts / 2 ** 32), true);
  out.set(data, 12);
  return out;
}

/** H.264 codec string whose level fits the picture size and rate (a too-low level makes encoders refuse). */
export function avcCodecFor(width: number, height: number, fps: number): string {
  const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  const level = mbps <= 245_760 ? 0x28 : mbps <= 522_240 ? 0x2a : mbps <= 589_824 ? 0x32 : mbps <= 983_040 ? 0x33 : 0x34;
  return `avc1.6400${level.toString(16)}`;
}

/** Target bitrate: the preset's 1080p figure scaled by pixel count and frame rate (relative to 30 fps). */
export function bitrateFor(bitrate1080: number, width: number, height: number, fps: number): number {
  return Math.round(bitrate1080 * ((width * height) / (1920 * 1080)) * Math.max(1, fps / 30));
}
