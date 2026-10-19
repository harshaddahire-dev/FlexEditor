import { z } from 'zod';
import { type Issue, validateSequence } from '@cutroom/core';
import { describeMedia, describeSequence } from '../describe';
import { parseTime, toSeconds } from '../time';
import { type AnalysisKind, type ToolCtx, ToolError, type ToolScope } from '../types';

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  scope: ToolScope;
  run(ctx: ToolCtx, args: z.infer<S>): Promise<unknown> | unknown;
}

export const defineTool = <S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> => t;

const time = z.union([z.number(), z.string()]).describe('Seconds (12.5), m:ss.f (1:02.5) or timecode (00:01:02:15)');
export const timeArg = time;

function findMedia(ctx: ToolCtx, id: string) {
  const m = ctx.host.media().find((x) => x.id === id || x.name === id);
  if (!m) throw new ToolError(`No media "${id}". Use list_media to see the ids.`);
  return m;
}

async function analysisOf(ctx: ToolCtx, mediaId: string, kind: AnalysisKind): Promise<unknown> {
  const m = findMedia(ctx, mediaId);
  const data = await ctx.host.analysis(m.id, kind);
  if (data === null) {
    const state = (m.status as unknown as Record<string, string>)[kind];
    throw new ToolError(state === 'unavailable' ? `${kind} is not available: the transcription engine is not installed.` : state === 'skipped' ? `${m.name} has no ${kind} (not applicable to this media).` : `${kind} for ${m.name} is not ready yet (status: ${state}).`);
  }
  return data;
}

const cap = <T>(list: T[], n: number): { items: T[]; note?: string } => (list.length > n ? { items: list.slice(0, n), note: `Showing ${n} of ${list.length}; narrow the range.` } : { items: list });

export const issueView = (i: Issue) => ({ severity: i.severity, code: i.code, message: i.message, ...(i.itemIds?.length ? { items: i.itemIds } : {}) });

export const readTools: ToolDef[] = [
  defineTool({
    name: 'get_overview',
    description: 'Project settings, the sequence summary (tracks, duration) and every media item with what analysis exists. Call this first.',
    schema: z.object({}),
    scope: 'read',
    run: (ctx) => {
      const seq = ctx.host.sequence();
      const view = describeSequence(seq, ctx.host.media(), { limit: 0 });
      return { sequence: { name: view.name, fps: view.fps, size: view.size, duration: view.duration, tracks: view.tracks }, media: ctx.host.media().map(describeMedia) };
    },
  }),
  defineTool({
    name: 'list_media',
    description: 'All media in the bin with ids, durations and analysis status.',
    schema: z.object({}),
    scope: 'read',
    run: (ctx) => ctx.host.media().map(describeMedia),
  }),
  defineTool({
    name: 'get_sequence',
    description: 'The clips on the timeline (ids, tracks, start/end/duration in seconds, source range, speed, gain…). Optionally limit to a time range or one track (e.g. "V1").',
    schema: z.object({ from: time.optional(), to: time.optional(), track: z.string().optional() }),
    scope: 'read',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      return describeSequence(seq, ctx.host.media(), { from: a.from === undefined ? undefined : parseTime(a.from, seq.timebase) / seq.timebase.rate, to: a.to === undefined ? undefined : parseTime(a.to, seq.timebase) / seq.timebase.rate, track: a.track });
    },
  }),
  defineTool({
    name: 'get_transcript',
    description: 'The speech transcript of a media file as timed sentences (seconds of MEDIA time). Use from/to to read part of it.',
    schema: z.object({ mediaId: z.string(), from: time.optional(), to: time.optional() }),
    scope: 'read',
    run: async (ctx, a) => {
      const t = (await analysisOf(ctx, a.mediaId, 'transcript')) as { segments: { text: string; startMs: number; endMs: number }[]; words: unknown[] };
      const from = a.from === undefined ? 0 : parseTime(a.from, ctx.host.sequence().timebase) / ctx.host.sequence().timebase.rate;
      const to = a.to === undefined ? Infinity : parseTime(a.to, ctx.host.sequence().timebase) / ctx.host.sequence().timebase.rate;
      const segs = t.segments.filter((s) => s.endMs / 1000 > from && s.startMs / 1000 < to).map((s) => ({ start: Math.round(s.startMs) / 1000, end: Math.round(s.endMs) / 1000, text: s.text }));
      const { items, note } = cap(segs, 120);
      return { segments: items, ...(note ? { note } : {}) };
    },
  }),
  defineTool({
    name: 'get_words',
    description: 'Word-level timings of a transcript between two media times — for cutting on an exact word boundary.',
    schema: z.object({ mediaId: z.string(), from: time, to: time }),
    scope: 'read',
    run: async (ctx, a) => {
      const tb = ctx.host.sequence().timebase;
      const t = (await analysisOf(ctx, a.mediaId, 'transcript')) as { words: { text: string; startMs: number; endMs: number }[] };
      const from = parseTime(a.from, tb) / tb.rate;
      const to = parseTime(a.to, tb) / tb.rate;
      const words = t.words.filter((w) => w.endMs / 1000 > from && w.startMs / 1000 < to).map((w) => ({ text: w.text, start: w.startMs / 1000, end: w.endMs / 1000 }));
      return cap(words, 300);
    },
  }),
  defineTool({
    name: 'search_transcript',
    description: 'Find where words or phrases are spoken. Searches one media file, or all of them.',
    schema: z.object({ query: z.string().min(1), mediaId: z.string().optional() }),
    scope: 'read',
    run: async (ctx, a) => {
      const q = a.query.toLowerCase();
      const targets = a.mediaId ? [findMedia(ctx, a.mediaId)] : ctx.host.media().filter((m) => m.status.transcript === 'done');
      const hits: { media: string; mediaId: string; start: number; end: number; text: string }[] = [];
      for (const m of targets) {
        const t = (await ctx.host.analysis(m.id, 'transcript')) as { segments: { text: string; startMs: number; endMs: number }[] } | null;
        for (const s of t?.segments ?? []) if (s.text.toLowerCase().includes(q)) hits.push({ media: m.name, mediaId: m.id, start: s.startMs / 1000, end: s.endMs / 1000, text: s.text });
      }
      return cap(hits, 50);
    },
  }),
  defineTool({
    name: 'get_silences',
    description: 'Silent stretches of a media file (seconds of MEDIA time), at least minSeconds long.',
    schema: z.object({ mediaId: z.string(), minSeconds: z.number().min(0.05).optional() }),
    scope: 'read',
    run: async (ctx, a) => {
      const d = (await analysisOf(ctx, a.mediaId, 'silences')) as { sampleRate: number; ranges: { start: number; end: number }[] };
      const min = a.minSeconds ?? 0;
      const out = d.ranges.map((r) => ({ start: r.start / d.sampleRate, end: r.end / d.sampleRate })).filter((r) => r.end - r.start >= min).map((r) => ({ start: Math.round(r.start * 1000) / 1000, end: Math.round(r.end * 1000) / 1000, duration: Math.round((r.end - r.start) * 1000) / 1000 }));
      return cap(out, 150);
    },
  }),
  defineTool({
    name: 'get_scenes',
    description: 'Shot boundaries (cuts) of a video file, in seconds of MEDIA time.',
    schema: z.object({ mediaId: z.string() }),
    scope: 'read',
    run: async (ctx, a) => {
      const d = (await analysisOf(ctx, a.mediaId, 'scenes')) as { cuts: { frame: number; time: number }[] };
      return cap(d.cuts.map((c) => ({ time: Math.round(c.time * 1000) / 1000, frame: c.frame })), 200);
    },
  }),
  defineTool({
    name: 'get_beats',
    description: 'Tempo (BPM) and beat times of a media file (seconds of MEDIA time) — for cutting to music.',
    schema: z.object({ mediaId: z.string(), from: time.optional(), to: time.optional() }),
    scope: 'read',
    run: async (ctx, a) => {
      const tb = ctx.host.sequence().timebase;
      const d = (await analysisOf(ctx, a.mediaId, 'beats')) as { bpm: number; confidence: number; beats: number[] };
      const from = a.from === undefined ? 0 : parseTime(a.from, tb) / tb.rate;
      const to = a.to === undefined ? Infinity : parseTime(a.to, tb) / tb.rate;
      const beats = d.beats.filter((b) => b >= from && b <= to).map((b) => Math.round(b * 1000) / 1000);
      return { bpm: d.bpm, confidence: d.confidence, ...cap(beats, 300) };
    },
  }),
  defineTool({
    name: 'get_loudness',
    description: 'EBU R128 loudness of a media file: integrated LUFS, loudness range, true peak.',
    schema: z.object({ mediaId: z.string() }),
    scope: 'read',
    run: (ctx, a) => analysisOf(ctx, a.mediaId, 'loudness'),
  }),
  defineTool({
    name: 'get_captions',
    description: 'The captions on the timeline: id, start/end (seconds), text and style.',
    schema: z.object({}),
    scope: 'read',
    run: (ctx) => {
      const seq = ctx.host.sequence();
      const caps = seq.tracks.filter((t) => t.kind === 'caption').flatMap((t) => Object.values(t.items)).filter((i) => i.kind === 'caption').sort((a, b) => a.start - b.start);
      const view = caps.map((c) => ({ id: c.id, start: toSeconds(c.start, seq.timebase), end: toSeconds(c.start + c.duration, seq.timebase), text: c.kind === 'caption' ? c.words.map((w) => w.text).join(' ') : '', style: c.kind === 'caption' ? c.styleId : '' }));
      return cap(view, 200);
    },
  }),
  defineTool({
    name: 'validate',
    description: 'Audit the whole sequence: overlaps, gaps, flash frames (very short clips), A/V desync, audio clicks, broken transitions.',
    schema: z.object({}),
    scope: 'read',
    run: (ctx) => {
      const seq = ctx.host.sequence();
      const issues = validateSequence(seq, ctx.host.env);
      return { ok: !issues.some((i) => i.severity === 'error'), issues: issues.slice(0, 60).map(issueView), ...(issues.length > 60 ? { note: `${issues.length - 60} more not shown.` } : {}) };
    },
  }),
];

export { toSeconds };
