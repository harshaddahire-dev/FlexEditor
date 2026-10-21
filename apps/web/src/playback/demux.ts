import { DataStream, MP4BoxBuffer, createFile } from 'mp4box';

/** One coded video sample from the container's sample table. */
export interface SampleRec {
  /** Decode-order index. */
  index: number;
  offset: number;
  size: number;
  /** Composition time, in `timescale` units, already shifted by the track's edit list. */
  cts: number;
  duration: number;
  sync: boolean;
}

export interface VideoTrackInfo {
  codec: string;
  width: number;
  height: number;
  timescale: number;
  /** avcC / hvcC / av1C bytes for codecs that need a decoder description; undefined for VP9. */
  description?: Uint8Array;
  /** Decode order. */
  samples: SampleRec[];
  /** Presentation order → decode index. */
  presentation: number[];
  fileSize: number;
}

const CHUNK = 1 << 20;

async function fetchRange(url: string, start: number, end: number, signal?: AbortSignal): Promise<{ data: ArrayBuffer; total: number }> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (res.status !== 206 && res.status !== 200) throw new Error(`Could not read ${url} (${res.status}).`);
  const data = await res.arrayBuffer();
  const cr = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
  return { data, total: cr ? Number(cr[1]) : data.byteLength };
}

type EntryWithConfig = { avcC?: { write(s: DataStream): void }; hvcC?: { write(s: DataStream): void }; av1C?: { write(s: DataStream): void } };

/** Where the `moov` box is: walks the top-level boxes by their 8–16 byte headers (a few tiny Range reads, never the media). */
async function locateMoov(url: string, signal?: AbortSignal): Promise<{ start: number; end: number; total: number }> {
  let pos = 0;
  let total = Number.POSITIVE_INFINITY;
  for (let guard = 0; guard < 64 && pos < total; guard++) {
    const { data, total: t } = await fetchRange(url, pos, pos + 15, signal);
    total = t;
    if (data.byteLength < 8) break;
    const v = new DataView(data);
    let size = v.getUint32(0);
    const type = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
    if (size === 1 && data.byteLength >= 16) size = Number(v.getBigUint64(8));
    else if (size === 0) size = total - pos; // runs to the end of the file
    if (size < 8) break;
    if (type === 'moov') return { start: pos, end: pos + size - 1, total };
    pos += size;
  }
  throw new Error('This file has no readable movie header (moov box).');
}

/**
 * Parse the sample table of the first video track. Only the `ftyp` and `moov` boxes are read — wherever `moov` is (proxies are
 * written with `+faststart`, many camera and screen-recorder files put it at the end); the media bytes are fetched later, per GOP,
 * with Range requests. Reading the whole file first would take seconds for a long proxy and minutes (or all memory) for an original.
 */
export async function openVideoTrack(url: string, signal?: AbortSignal): Promise<VideoTrackInfo> {
  const file = createFile();
  let isReady = false;
  let failure: Error | undefined;
  file.onError = (_m: string, msg?: string) => {
    failure = new Error(`MP4 parse error: ${msg ?? _m}`);
  };
  file.onReady = () => {
    isReady = true;
  };

  const moov = await locateMoov(url, signal);
  const total = moov.total;
  // mp4box parses a contiguous stream, so it gets one: the file type box, then the movie header right after it. Sample offsets come
  // from the header's own chunk table (absolute positions in the real file), so where the header sits in this stream does not matter.
  let at = 0;
  if (moov.start > 0) {
    const head = await fetchRange(url, 0, Math.min(moov.start, 4096) - 1, signal).catch(() => null);
    const v = head && head.data.byteLength >= 8 ? new DataView(head.data) : null;
    const ftypSize = v ? v.getUint32(0) : 0;
    const isFtyp = v ? String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7)) === 'ftyp' : false;
    if (head && isFtyp && ftypSize >= 8 && ftypSize <= head.data.byteLength) {
      file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(head.data.slice(0, ftypSize), 0));
      at = ftypSize;
    }
  }
  for (let pos = moov.start; pos <= moov.end && !isReady && !failure; ) {
    const { data } = await fetchRange(url, pos, Math.min(moov.end, pos + 16 * CHUNK - 1), signal);
    if (!data.byteLength) break;
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(data, at));
    pos += data.byteLength;
    at += data.byteLength;
  }
  file.flush();
  if (!failure && !isReady) failure = new Error('Could not read the movie header of this file.');
  if (failure) throw failure;
  const info = file.getInfo();
  const track = info.videoTracks[0];
  if (!track) throw new Error('The proxy has no video track.');

  const trak = file.getTrackById(track.id);
  const entry = (trak.mdia.minf.stbl.stsd.entries[0] ?? {}) as EntryWithConfig;
  const box = entry.avcC ?? entry.hvcC ?? entry.av1C;
  let description: Uint8Array | undefined;
  if (box) {
    const stream = new DataStream(undefined, 0, 1 /* BIG_ENDIAN */);
    box.write(stream);
    description = new Uint8Array(stream.buffer as ArrayBuffer, 8); // skip the box header
  }

  // Edit list: an empty edit (media_time -1) delays the track; a first media_time > 0 trims its head.
  let shift = 0; // in track timescale units, added to every cts
  const elst = (trak as unknown as { edts?: { elst?: { entries: { segment_duration: number; media_time: number }[] } } }).edts?.elst;
  if (elst) {
    const movieTimescale = info.timescale;
    for (const e of elst.entries) {
      if (e.media_time === -1) shift += (e.segment_duration / movieTimescale) * track.timescale;
      else {
        shift -= e.media_time;
        break;
      }
    }
  }

  const raw = file.getTrackSamplesInfo(track.id);
  const samples: SampleRec[] = raw.map((s, i) => ({ index: i, offset: s.offset, size: s.size, cts: s.cts + shift, duration: s.duration, sync: s.is_sync }));
  const presentation = samples.map((s) => s.index).sort((a, b) => samples[a]!.cts - samples[b]!.cts || a - b);

  return {
    codec: track.codec,
    width: track.video?.width ?? track.track_width,
    height: track.video?.height ?? track.track_height,
    timescale: track.timescale,
    description,
    samples,
    presentation,
    fileSize: total,
  };
}

export { fetchRange };
