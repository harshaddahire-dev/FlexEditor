import { frameTicks } from './edit/units';
import type { CaptionItem, Clip, Ticks, Timebase } from './edit/types';

export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface CaptionOptions {
  maxCharsPerLine?: number;
  maxLines?: number;
  /** Longest a caption may stay on screen, seconds. */
  maxSeconds?: number;
  /** Shortest, seconds — extended into silence when the next caption allows. */
  minSeconds?: number;
  /** A pause at least this long (seconds) starts a new caption. */
  pauseSeconds?: number;
}

export interface CaptionDraft {
  start: Ticks;
  duration: Ticks;
  words: { text: string; start: Ticks; end: Ticks }[];
}

const SENTENCE_END = /[.!?…]["')\]]*$/;
const CLAUSE_END = /[,;:]["')\]]*$/;

/**
 * Captions for the part of a transcript a clip actually plays. Each word is mapped from media time to timeline time
 * through the clip's trim and speed (so captions follow edits), then words are grouped into on-screen captions that
 * break on sentences, pauses and line capacity, snapped to whole frames and never overlapping.
 */
export function captionsForClip(words: readonly TranscriptWord[], clip: Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'speed'>, tb: Timebase, opts: CaptionOptions = {}): CaptionDraft[] {
  const maxChars = (opts.maxCharsPerLine ?? 32) * (opts.maxLines ?? 2);
  const maxTicks = Math.round((opts.maxSeconds ?? 6) * tb.rate);
  const minTicks = Math.round((opts.minSeconds ?? 0.7) * tb.rate);
  const pauseTicks = Math.round((opts.pauseSeconds ?? 0.6) * tb.rate);
  const frame = frameTicks(tb);
  const speed = clip.speed.num / clip.speed.den;
  const clipEnd = clip.start + clip.duration;
  const srcEnd = clip.sourceIn + clip.duration * speed;
  const toTimeline = (mediaTicks: number): number => Math.min(clipEnd, Math.max(clip.start, Math.round(clip.start + (mediaTicks - clip.sourceIn) / speed)));

  const mapped = words
    .map((w) => ({ text: w.text.trim(), s: (w.startMs / 1000) * tb.rate, e: (w.endMs / 1000) * tb.rate }))
    .filter((w) => w.text && w.e > clip.sourceIn && w.s < srcEnd)
    .map((w) => ({ text: w.text, start: toTimeline(w.s), end: Math.max(toTimeline(w.e), toTimeline(w.s) + 1) }));

  // group
  const groups: typeof mapped[] = [];
  let cur: typeof mapped = [];
  const chars = (g: typeof mapped) => g.reduce((n, w) => n + w.text.length + 1, 0);
  for (const w of mapped) {
    const prev = cur[cur.length - 1];
    if (prev && (chars(cur) + w.text.length > maxChars || w.start - prev.end >= pauseTicks || w.end - cur[0]!.start > maxTicks)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
    if (SENTENCE_END.test(w.text) && cur.length >= 2) (groups.push(cur), (cur = []));
    else if (CLAUSE_END.test(w.text) && chars(cur) >= maxChars * 0.6) (groups.push(cur), (cur = []));
  }
  if (cur.length) groups.push(cur);

  // times: frame-snapped, long enough, non-overlapping
  const drafts: CaptionDraft[] = [];
  groups.forEach((g, i) => {
    const start = Math.max(clip.start, Math.floor(g[0]!.start / frame) * frame);
    let end = Math.min(clipEnd, Math.ceil(g[g.length - 1]!.end / frame) * frame);
    end = Math.max(end, Math.min(clipEnd, start + Math.ceil(minTicks / frame) * frame));
    const next = groups[i + 1];
    if (next) end = Math.min(end, Math.max(start + frame, Math.floor(next[0]!.start / frame) * frame));
    if (end - start < frame) end = start + frame;
    drafts.push({ start, duration: end - start, words: g.map((w) => ({ text: w.text, start: Math.max(start, Math.min(w.start, end)), end: Math.min(end, Math.max(w.end, start)) })) });
  });
  // a later caption may not start before the previous one ends
  for (let i = 1; i < drafts.length; i++) {
    const p = drafts[i - 1]!;
    if (drafts[i]!.start < p.start + p.duration) p.duration = Math.max(frame, drafts[i]!.start - p.start);
  }
  return drafts;
}

export const captionText = (c: Pick<CaptionItem, 'words'>): string => c.words.map((w) => w.text).join(' ');

/** The word being spoken at `t` (the last one that has started), or -1 before the first. */
export function activeWordIndex(c: Pick<CaptionItem, 'words'>, t: Ticks): number {
  let idx = -1;
  for (let i = 0; i < c.words.length; i++) if (c.words[i]!.start <= t) idx = i;
  return idx;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function stamp(ticks: Ticks, tb: Timebase, sep: ',' | '.'): string {
  const ms = Math.round((ticks / tb.rate) * 1000);
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}

/** SRT (or WebVTT) text for caption items, wrapping nothing: line breaks are the player's job. */
export function captionsToSubtitles(items: readonly Pick<CaptionItem, 'start' | 'duration' | 'words'>[], tb: Timebase, format: 'srt' | 'vtt' = 'srt'): string {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const body = sorted.map((c, i) => `${format === 'srt' ? `${i + 1}\n` : ''}${stamp(c.start, tb, format === 'srt' ? ',' : '.')} --> ${stamp(c.start + c.duration, tb, format === 'srt' ? ',' : '.')}\n${captionText(c)}\n`).join('\n');
  return format === 'vtt' ? `WEBVTT\n\n${body}` : body;
}

/** Words for edited caption text: timings spread across the caption in proportion to word length. */
export function retimeWords(text: string, start: Ticks, duration: Ticks): { text: string; start: Ticks; end: Ticks }[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const total = words.reduce((n, w) => n + w.length + 1, 0);
  let at = 0;
  return words.map((w) => {
    const from = start + Math.round((at / total) * duration);
    at += w.length + 1;
    const to = start + Math.round((at / total) * duration);
    return { text: w, start: from, end: Math.max(from, Math.min(start + duration, to)) };
  });
}
