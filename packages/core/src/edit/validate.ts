import { audioJoins } from './audio';
import { maxTransitionDuration } from './normalize';
import { allClips, itemEnd, sourceSpan, syncDelta, trackItems } from './query';
import { type Clip, type EditEnv, type Sequence, type Track, isClip } from './types';
import { frameTicks, sampleTicks } from './units';

export interface Issue {
  severity: 'error' | 'warn';
  code:
    | 'overlap' | 'grid' | 'bounds' | 'kind' | 'media' | 'duplicate_id' | 'keyframe_bounds' | 'keyframe_order' | 'fade'
    | 'transition' | 'handle' | 'desync' | 'link' | 'caption' | 'flash_frame' | 'gap' | 'audio_click' | 'speed' | 'integer';
  message: string;
  itemIds: string[];
  trackId?: string;
  time?: number;
}

export interface ValidateOptions {
  /** Flag clips shorter than this many frames (default 3). */
  flashFrames?: number;
  /** Report gaps between consecutive clips on video tracks. */
  gaps?: boolean;
}

/** Linked clips at normal speed must match exactly; a speed change rounds to whole ticks, so allow one tick there. */
const syncTolerance = (a: Clip): number => (a.speed.num === a.speed.den ? 1e-6 : 1);

/**
 * Full structural audit of a sequence. Never throws: returns every problem it can find. The edit engine guarantees
 * no `error` ever results from a successful operation; QA calls this to double-check and to add editorial warnings.
 */
export function validateSequence(seq: Sequence, env: Pick<EditEnv, 'getMedia'>, opts: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const add = (i: Issue) => issues.push(i);
  const tb = seq.timebase;
  const frame = frameTicks(tb);
  const sample = sampleTicks(tb);

  const ids = new Set<string>();
  const dup = (id: string, where: string) => {
    if (ids.has(id)) add({ severity: 'error', code: 'duplicate_id', message: `Duplicate id ${id} (${where}).`, itemIds: [id] });
    ids.add(id);
  };
  for (const t of seq.tracks) dup(t.id, 'track');
  for (const m of seq.markers) dup(m.id, 'marker');

  for (const track of seq.tracks) {
    const sorted = trackItems(track);
    sorted.forEach((item, i) => {
      dup(item.id, 'item');
      const prev = sorted[i - 1];
      if (prev && itemEnd(prev) > item.start) {
        add({ severity: 'error', code: 'overlap', message: `${item.id} overlaps ${prev.id} on ${track.name}.`, itemIds: [prev.id, item.id], trackId: track.id, time: item.start });
      }
      if (!Number.isInteger(item.start) || !Number.isInteger(item.duration) || item.duration <= 0 || item.start < 0) {
        add({ severity: 'error', code: 'integer', message: `${item.id} has invalid timing (${item.start}+${item.duration}).`, itemIds: [item.id], trackId: track.id });
      }
      if (isClip(item)) validateClip(item, track);
      else {
        if (track.kind !== 'caption') add({ severity: 'error', code: 'kind', message: `Caption ${item.id} is not on a caption track.`, itemIds: [item.id], trackId: track.id });
        if (item.start % frame !== 0 || item.duration % frame !== 0) add({ severity: 'error', code: 'grid', message: `Caption ${item.id} is off the frame grid.`, itemIds: [item.id], trackId: track.id });
        for (const w of item.words) {
          if (w.end < w.start || w.start < item.start || w.end > itemEnd(item)) {
            add({ severity: 'warn', code: 'caption', message: `Caption ${item.id} word "${w.text}" lies outside the caption.`, itemIds: [item.id], trackId: track.id, time: w.start });
          }
        }
      }
    });

    for (const tr of track.transitions) {
      dup(tr.id, 'transition');
      const a = track.items[tr.betweenClipIds[0]];
      const b = track.items[tr.betweenClipIds[1]];
      if (!a || !b || !isClip(a) || !isClip(b) || itemEnd(a) !== b.start) {
        add({ severity: 'error', code: 'transition', message: `Transition ${tr.id} is not between two touching clips.`, itemIds: [tr.id], trackId: track.id });
        continue;
      }
      const max = maxTransitionDuration({ env }, a, b, tr.alignment);
      if (tr.duration > max) add({ severity: 'error', code: 'handle', message: `Transition ${tr.id} needs ${tr.duration} ticks of handle but only ${max} exist.`, itemIds: [tr.id, a.id, b.id], trackId: track.id, time: b.start });
    }

    if (track.kind === 'video' || track.kind === 'graphics') {
      const clips = sorted.filter(isClip);
      clips.forEach((c, i) => {
        if (c.duration < (opts.flashFrames ?? 3) * frame) {
          add({ severity: 'warn', code: 'flash_frame', message: `Clip ${c.id} is only ${Math.round(c.duration / frame)} frame(s) long.`, itemIds: [c.id], trackId: track.id, time: c.start });
        }
        const next = clips[i + 1];
        if (opts.gaps && next && next.start > itemEnd(c)) {
          add({ severity: 'warn', code: 'gap', message: `Gap of ${Math.round((next.start - itemEnd(c)) / frame)} frame(s) on ${track.name}.`, itemIds: [c.id, next.id], trackId: track.id, time: itemEnd(c) });
        }
      });
    }

    if (track.kind === 'audio') {
      for (const j of audioJoins(track, tb, env)) {
        if ((j.kind === 'fade-in' || j.kind === 'fade-out') && j.duration < sample) {
          add({ severity: 'warn', code: 'audio_click', message: `Hard audio edge at ${j.time} on ${track.name} (no fade).`, itemIds: [j.clipId], trackId: track.id, time: j.time });
        }
      }
    }
  }

  // link groups must stay in sync
  const groups = new Map<string, Clip[]>();
  for (const c of allClips(seq)) if (c.linkGroupId) groups.set(c.linkGroupId, [...(groups.get(c.linkGroupId) ?? []), c]);
  for (const [g, list] of groups) {
    if (list.length < 2) add({ severity: 'warn', code: 'link', message: `Link group ${g} has a single member.`, itemIds: list.map((c) => c.id) });
    const ref = list[0]!;
    for (const c of list.slice(1)) {
      if (c.mediaId !== ref.mediaId || c.speed.num !== ref.speed.num || c.speed.den !== ref.speed.den) continue;
      const d = syncDelta(c, ref);
      if (Math.abs(d) > syncTolerance(c)) {
        add({ severity: 'warn', code: 'desync', message: `Linked clips ${ref.id} and ${c.id} are out of sync by ${d} ticks (${((d / tb.rate) * 1000).toFixed(2)} ms).`, itemIds: [ref.id, c.id], time: c.start });
      }
    }
  }

  function validateClip(c: Clip, track: Track): void {
    const where = { itemIds: [c.id], trackId: track.id, time: c.start };
    if (track.kind === 'caption') add({ severity: 'error', code: 'kind', message: `Clip ${c.id} is on a caption track.`, ...where });
    if (track.kind !== 'audio' && (c.start % frame !== 0 || c.duration % frame !== 0)) add({ severity: 'error', code: 'grid', message: `Clip ${c.id} is off the frame grid.`, ...where });
    if (c.speed.num <= 0 || c.speed.den <= 0) add({ severity: 'error', code: 'speed', message: `Clip ${c.id} has an invalid speed.`, ...where });
    const media = env.getMedia(c.mediaId);
    if (!media) add({ severity: 'error', code: 'media', message: `Clip ${c.id} references unknown media ${c.mediaId}.`, ...where });
    else {
      if (c.sourceIn < 0 || (media.duration !== null && c.sourceIn + sourceSpan(c.duration, c.speed) > media.duration)) {
        add({ severity: 'error', code: 'bounds', message: `Clip ${c.id} reads outside its media.`, ...where });
      }
      if ((track.kind === 'audio' && !media.hasAudio) || (track.kind === 'video' && !media.hasVideo && media.kind !== 'image')) {
        add({ severity: 'error', code: 'kind', message: `Clip ${c.id} (${media.id}) does not fit a ${track.kind} track.`, ...where });
      }
    }
    if (c.audio.fadeIn < 0 || c.audio.fadeOut < 0 || c.audio.fadeIn + c.audio.fadeOut > c.duration) {
      add({ severity: 'error', code: 'fade', message: `Fades on ${c.id} exceed its length.`, ...where });
    }
    for (const [prop, kfs] of Object.entries(c.keyframes)) {
      kfs.forEach((k, i) => {
        if (k.time < 0 || k.time > c.duration) add({ severity: 'error', code: 'keyframe_bounds', message: `${prop} keyframe at ${k.time} is outside clip ${c.id}.`, ...where });
        if (i && k.time <= kfs[i - 1]!.time) add({ severity: 'error', code: 'keyframe_order', message: `${prop} keyframes on ${c.id} are not strictly ordered.`, ...where });
      });
    }
  }

  return issues;
}

export const hasErrors = (issues: readonly Issue[]): boolean => issues.some((i) => i.severity === 'error');
