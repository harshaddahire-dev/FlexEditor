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

/**
 * Parse the sample table of the first video track. Only the `moov` box is read (proxies are written with
 * `+faststart`); the media bytes are fetched later, per GOP, with Range requests.
 */
export async function openVideoTrack(url: string, signal?: AbortSignal): Promise<VideoTrackInfo> {
  const file = createFile();
  let ready: (() => void) | undefined;
  let failure: Error | undefined;
  const done = new Promise<void>((resolve) => (ready = resolve));
  file.onError = (_m: string, msg?: string) => {
    failure = new Error(`MP4 parse error: ${msg ?? _m}`);
    ready?.();
  };
  file.onReady = () => ready?.();

  let pos = 0;
  let total = Number.POSITIVE_INFINITY;
  while (pos < total) {
    const { data, total: t } = await fetchRange(url, pos, pos + CHUNK - 1, signal);
    total = t;
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(data, pos));
    pos += data.byteLength;
    const state = await Promise.race([done.then(() => 'ready' as const), Promise.resolve('wait' as const)]);
    if (state === 'ready' || failure) break;
  }
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
