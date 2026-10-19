import { create } from 'zustand';
import { type Media, type SampleRange, reducePeaks } from '@cutroom/core';

export interface WaveformData {
  samplesPerBin: number;
  sampleRate: number;
  /** levels[0] is the stored resolution; each next level halves it. Interleaved [min, max] Int16 pairs. */
  levels: Int16Array[];
}

export interface FilmstripData {
  image: HTMLImageElement;
  interval: number;
  thumbW: number;
  thumbH: number;
  cols: number;
  count: number;
}

export interface SilenceData {
  sampleRate: number;
  ranges: SampleRange[];
}

export interface TranscriptData {
  language: string;
  model: string;
  words: { text: string; startMs: number; endMs: number }[];
  segments: { text: string; startMs: number; endMs: number; wordStart: number; wordEnd: number }[];
}

const analysisUrl = (id: string, name: string, v: string | number): string => `/api/media/${id}/analysis/${name}?v=${v}`;

/** Bumped whenever something finishes loading, so canvases that read the caches know to repaint. */
export const useAnalysis = create<{ version: number }>()(() => ({ version: 0 }));
const bump = () => useAnalysis.setState((s) => ({ version: s.version + 1 }));

type Entry<T> = { key: string; value: T | null; loading: boolean };
const waveforms = new Map<string, Entry<WaveformData>>();
const filmstrips = new Map<string, Entry<FilmstripData>>();
const silences = new Map<string, Entry<SilenceData>>();

/** Fetch-once cache: returns what is loaded now (or null) and starts the load when the stage is ready. */
function cached<T>(cache: Map<string, Entry<T>>, m: Media, ready: boolean, load: (key: string) => Promise<T>): T | null {
  const key = `${m.mtimeMs}:${m.status.waveform}:${m.status.filmstrip}:${m.status.silences}`;
  const hit = cache.get(m.id);
  if (hit && hit.key === key) return hit.value;
  if (!ready || (hit?.loading && hit.key === key)) return hit?.key === key ? hit.value : null;
  const entry: Entry<T> = { key, value: null, loading: true };
  cache.set(m.id, entry);
  load(key)
    .then((v) => {
      entry.value = v;
    })
    .catch(() => undefined)
    .finally(() => {
      entry.loading = false;
      bump();
    });
  return null;
}

export function waveformOf(m: Media | undefined): WaveformData | null {
  if (!m) return null;
  return cached(waveforms, m, m.status.waveform === 'done', async () => {
    const [meta, bin] = await Promise.all([
      fetch(analysisUrl(m.id, 'waveform', m.mtimeMs)).then((r) => r.json() as Promise<{ samplesPerBin: number; sampleRate: number }>),
      fetch(analysisUrl(m.id, 'waveform.bin', m.mtimeMs)).then((r) => r.arrayBuffer()),
    ]);
    const levels: Int16Array[] = [new Int16Array(bin)];
    while (levels.at(-1)!.length > 8) levels.push(reducePeaks(levels.at(-1)!));
    return { samplesPerBin: meta.samplesPerBin, sampleRate: meta.sampleRate, levels };
  });
}

export function filmstripOf(m: Media | undefined): FilmstripData | null {
  if (!m) return null;
  return cached(filmstrips, m, m.status.filmstrip === 'done', async () => {
    const meta = (await fetch(analysisUrl(m.id, 'filmstrip', m.mtimeMs)).then((r) => r.json())) as Omit<FilmstripData, 'image'>;
    const image = new Image();
    image.src = analysisUrl(m.id, 'filmstrip.jpg', m.mtimeMs);
    await image.decode();
    return { ...meta, image };
  });
}

export function silencesOf(m: Media | undefined): SilenceData | null {
  if (!m) return null;
  return cached(silences, m, m.status.silences === 'done', async () => (await fetch(analysisUrl(m.id, 'silences', m.mtimeMs))).json() as Promise<SilenceData>);
}

/** Full transcript of one media item (fetched on demand by the transcript panel). */
export async function fetchTranscript(m: Media): Promise<TranscriptData | null> {
  if (m.status.transcript !== 'done') return null;
  const r = await fetch(analysisUrl(m.id, 'transcript', m.mtimeMs));
  return r.ok ? ((await r.json()) as TranscriptData) : null;
}
