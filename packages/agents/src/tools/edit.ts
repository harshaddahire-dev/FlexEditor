import { z } from 'zod';
import {
  type CaptionItem,
  type Clip,
  type Media,
  type Op,
  type Sequence,
  type Track,
  captionsForClip,
  defaultParams,
  effectDef,
  findItem,
  frameTicks,
  hasCaptionStyle,
  CAPTION_STYLES,
  isCaption,
  isClip,
  maxTransitionDuration,
  mediaRef,
  msToTicks,
  TRANSITIONS,
  transitionDef,
  trackItems,
  validateEffect,
} from '@cutroom/core';
import { describeClip } from '../describe';
import { describeTime, parseTime, toSeconds } from '../time';
import { type ToolCtx, ToolError } from '../types';
import { type ToolDef, defineTool, timeArg } from './read';

const STILL_SECONDS = 5;

function clipOf(seq: Sequence, id: string): { clip: Clip; track: Track } {
  const f = findItem(seq, id);
  if (!f || !isClip(f.item)) throw new ToolError(`No clip "${id}". Use get_sequence to see current clip ids.`);
  return { clip: f.item, track: f.track };
}

function trackNamed(seq: Sequence, name: string): Track {
  const t = seq.tracks.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
  if (!t) throw new ToolError(`No track "${name}". Tracks: ${seq.tracks.map((x) => x.name).join(', ')}.`);
  return t;
}

const clipIds = (seq: Sequence): Set<string> => new Set(seq.tracks.flatMap((t) => trackItems(t).filter(isClip).map((c) => c.id)));

/** Run ops as one transaction and report which clips appeared (so the model learns the new ids). */
function commit(ctx: ToolCtx, ops: Op[], label: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const before = clipIds(ctx.host.sequence());
  const { revision } = ctx.host.applyOps(ops, { label, origin: `agent:${ctx.role}`, group: ctx.group });
  ctx.onEdit(revision);
  const seq = ctx.host.sequence();
  const media = new Map(ctx.host.media().map((m) => [m.id, m] as const));
  const created: Record<string, unknown>[] = [];
  for (const t of seq.tracks) for (const c of trackItems(t)) if (isClip(c) && !before.has(c.id)) created.push(describeClip(c, seq, media, t.name));
  return { ok: true, ...extra, ...(created.length ? { newClips: created } : {}), revision };
}

function findMediaFor(ctx: ToolCtx, id: string): Media {
  const m = ctx.host.media().find((x) => x.id === id || x.name === id);
  if (!m) throw new ToolError(`No media "${id}". Use list_media to see the ids.`);
  if (m.missing) throw new ToolError(`${m.name} is missing from disk; it cannot be placed.`);
  return m;
}

/** Whole-percent speeds are exact rationals (1.5 → 3/2), keeping the engine's integer speed maths intact. */
function speedRatio(x: number): { num: number; den: number } {
  const n = Math.round(x * 100);
  if (n <= 0) throw new ToolError('speed must be greater than 0.');
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(n, 100);
  return { num: n / d, den: 100 / d };
}

const KEYFRAME_PROPS = ['opacity', 'position.x', 'position.y', 'scale.x', 'scale.y', 'rotation', 'audio.gainDb'] as const;

export const editTools: ToolDef[] = [
  defineTool({
    name: 'add_clip',
    description:
      'Place media on the timeline at a time. Video goes on a video track with its audio linked on an audio track. `insert` pushes later clips right (ripple); `overwrite` replaces what is there. sourceIn/sourceOut pick a part of the media (seconds of media time); omit both for the whole file.',
    schema: z.object({
      mediaId: z.string(),
      at: timeArg,
      sourceIn: timeArg.optional(),
      sourceOut: timeArg.optional(),
      mode: z.enum(['insert', 'overwrite']).default('insert'),
      videoTrack: z.string().optional().describe('e.g. "V2"; default: first unlocked video track'),
      audioTrack: z.string().optional().describe('e.g. "A2"; default: first unlocked audio track'),
    }),
    scope: 'edit',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      const tb = seq.timebase;
      const m = findMediaFor(ctx, a.mediaId);
      const ref = mediaRef(m, tb);
      const frame = frameTicks(tb);
      const full = ref.duration ?? STILL_SECONDS * tb.rate;
      const sIn = a.sourceIn === undefined ? 0 : parseTime(a.sourceIn, tb, 'sourceIn');
      const sOut = a.sourceOut === undefined ? Math.floor(full / frame) * frame || full : parseTime(a.sourceOut, tb, 'sourceOut');
      if (sOut <= sIn) throw new ToolError('sourceOut must be after sourceIn.');
      const freeTrack = (kind: Track['kind'], name?: string): Track | undefined => (name ? trackNamed(seq, name) : seq.tracks.find((t) => t.kind === kind && !t.locked));
      const clips: Extract<Op, { type: 'insert' }>['clips'] = [];
      if (ref.hasVideo) {
        const vt = freeTrack('video', a.videoTrack);
        if (!vt) throw new ToolError('There is no unlocked video track.');
        clips.push({ trackId: vt.id, mediaId: m.id, sourceIn: sIn, sourceOut: sOut, name: m.name, createdBy: `agent:${ctx.role}`, ...(ref.hasAudio ? { link: 'av' } : {}) });
      }
      if (ref.hasAudio) {
        const at = freeTrack('audio', a.audioTrack);
        if (at) clips.push({ trackId: at.id, mediaId: m.id, sourceIn: sIn, sourceOut: sOut, name: m.name, createdBy: `agent:${ctx.role}`, ...(ref.hasVideo ? { link: 'av' } : {}) });
        else if (!ref.hasVideo) throw new ToolError('There is no unlocked audio track.');
      }
      if (clips.length === 1) delete clips[0]!.link;
      const when = parseTime(a.at, tb, 'at');
      return commit(ctx, [{ type: a.mode, at: when, clips } as Op], `Add ${m.name}`, { placedAt: describeTime(when, tb) });
    },
  }),
  defineTool({
    name: 'split',
    description: 'Cut a clip in two at a time (linked audio/video are cut together). Returns the new clip.',
    schema: z.object({ clipId: z.string(), at: timeArg, linked: z.boolean().default(true) }),
    scope: 'edit',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      clipOf(seq, a.clipId);
      const at = parseTime(a.at, seq.timebase, 'at');
      return commit(ctx, [{ type: 'split', clipId: a.clipId, at, linked: a.linked }], 'Split clip', { splitAt: describeTime(at, seq.timebase) });
    },
  }),
  defineTool({
    name: 'trim',
    description:
      'Move one edge of a clip to a timeline time. The picture keeps its timing (what plays at a given moment still plays then); `ripple` also closes or opens the gap by shifting later clips.',
    schema: z.object({ clipId: z.string(), edge: z.enum(['start', 'end']), to: timeArg, ripple: z.boolean().default(false), linked: z.boolean().default(true) }),
    scope: 'edit',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      clipOf(seq, a.clipId);
      const to = parseTime(a.to, seq.timebase, 'to');
      return commit(ctx, [{ type: a.ripple ? 'rippleTrim' : 'trim', clipId: a.clipId, edge: a.edge, to, linked: a.linked } as Op], `Trim ${a.edge}`);
    },
  }),
  defineTool({
    name: 'delete_clips',
    description: 'Remove clips. `ripple` closes the gap they leave. Linked partners go too.',
    schema: z.object({ clipIds: z.array(z.string()).min(1), ripple: z.boolean().default(false) }),
    scope: 'edit',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      for (const id of a.clipIds) clipOf(seq, id);
      return commit(ctx, [a.ripple ? { type: 'rippleDelete', clipIds: a.clipIds, linked: true } : { type: 'delete', itemIds: a.clipIds, linked: true }], `Delete ${a.clipIds.length} clip(s)`);
    },
  }),
  defineTool({
    name: 'remove_range',
    description:
      'Cut a stretch of TIMELINE time out of every (or the named) track — e.g. remove a silence or a flubbed sentence. With ripple (default) everything after moves left to close the gap. Edges snap inward to whole frames.',
    schema: z.object({ from: timeArg, to: timeArg, tracks: z.array(z.string()).optional().describe('track names; default all unlocked'), ripple: z.boolean().default(true) }),
    scope: 'edit',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      const tb = seq.timebase;
      const start = parseTime(a.from, tb, 'from');
      const end = parseTime(a.to, tb, 'to');
      if (end <= start) throw new ToolError('`to` must be after `from`.');
      const trackIds = a.tracks?.map((n) => trackNamed(seq, n).id);
      return commit(ctx, [{ type: 'removeRange', start, end, ...(trackIds ? { trackIds } : {}), ripple: a.ripple, snap: 'inward' }], `Remove ${toSeconds(end - start, tb)} s`, { removed: `${describeTime(start, tb)} → ${describeTime(end, tb)}` });
    },
  }),
  defineTool({
    name: 'move_clips',
    description: 'Move clips: to a new start time for the first clip (`to`) or by an offset (`delta`, seconds, may be negative); optionally onto another track. Fails rather than overlapping.',
    schema: z.object({ clipIds: z.array(z.string()).min(1), to: timeArg.optional(), delta: z.number().optional(), track: z.string().optional(), overwrite: z.boolean().default(false) }),
    scope: 'edit',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      const tb = seq.timebase;
      for (const id of a.clipIds) clipOf(seq, id);
      if ((a.to === undefined) === (a.delta === undefined)) throw new ToolError('Give exactly one of `to` or `delta`.');
      const op: Extract<Op, { type: 'move' }> = { type: 'move', clipIds: a.clipIds, linked: true, mode: a.overwrite ? 'overwrite' : 'strict', ...(a.to !== undefined ? { to: parseTime(a.to, tb, 'to') } : { delta: parseTime(a.delta, tb, 'delta') }), ...(a.track ? { toTrackId: trackNamed(seq, a.track).id } : {}) };
      return commit(ctx, [op], 'Move clips');
    },
  }),
  defineTool({
    name: 'set_speed',
    description: 'Change a clip\'s playback speed (1 = normal, 2 = double, 0.5 = half). Linked audio follows. `ripple` shifts later clips to absorb the new length.',
    schema: z.object({ clipId: z.string(), speed: z.number().min(0.1).max(10), ripple: z.boolean().default(false) }),
    scope: 'edit',
    run: (ctx, a) => {
      clipOf(ctx.host.sequence(), a.clipId);
      return commit(ctx, [{ type: 'setSpeed', clipId: a.clipId, speed: speedRatio(a.speed), linked: true, ripple: a.ripple }], `Speed ×${a.speed}`);
    },
  }),
  defineTool({
    name: 'set_clip',
    description: 'Set clip properties: audio gain (dB), pan (-1…1), fades (ms), opacity (0…1), position (px from centre), scale (1 = fit), rotation (degrees), enabled, name.',
    schema: z.object({
      clipId: z.string(),
      gainDb: z.number().min(-96).max(24).optional(),
      pan: z.number().min(-1).max(1).optional(),
      fadeInMs: z.number().min(0).optional(),
      fadeOutMs: z.number().min(0).optional(),
      opacity: z.number().min(0).max(1).optional(),
      positionX: z.number().optional(),
      positionY: z.number().optional(),
      scale: z.number().min(0.01).max(8).optional(),
      rotation: z.number().optional(),
      enabled: z.boolean().optional(),
      name: z.string().optional(),
      linked: z.boolean().default(false),
    }),
    scope: 'edit',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      clipOf(seq, a.clipId);
      const tb = seq.timebase;
      const audio = { ...(a.gainDb !== undefined ? { gainDb: a.gainDb } : {}), ...(a.pan !== undefined ? { pan: a.pan } : {}), ...(a.fadeInMs !== undefined ? { fadeIn: msToTicks(a.fadeInMs, tb) } : {}), ...(a.fadeOutMs !== undefined ? { fadeOut: msToTicks(a.fadeOutMs, tb) } : {}) };
      const transform = {
        ...(a.opacity !== undefined ? { opacity: a.opacity } : {}),
        ...(a.positionX !== undefined || a.positionY !== undefined ? { position: { ...(a.positionX !== undefined ? { x: a.positionX } : {}), ...(a.positionY !== undefined ? { y: a.positionY } : {}) } } : {}),
        ...(a.scale !== undefined ? { scale: { x: a.scale, y: a.scale } } : {}),
        ...(a.rotation !== undefined ? { rotation: a.rotation } : {}),
      };
      const patch = { ...(a.enabled !== undefined ? { enabled: a.enabled } : {}), ...(a.name !== undefined ? { name: a.name } : {}), ...(Object.keys(audio).length ? { audio } : {}), ...(Object.keys(transform).length ? { transform } : {}) };
      if (!Object.keys(patch).length) throw new ToolError('Nothing to set.');
      return commit(ctx, [{ type: 'setClipProps', clipId: a.clipId, patch, linked: a.linked }], 'Set clip properties');
    },
  }),
  defineTool({
    name: 'set_track',
    description: 'Mute/hide, solo or lock a track by name (e.g. "A1").',
    schema: z.object({ track: z.string(), muted: z.boolean().optional(), solo: z.boolean().optional(), locked: z.boolean().optional() }),
    scope: 'edit',
    run: (ctx, a) => {
      const t = trackNamed(ctx.host.sequence(), a.track);
      const patch = { ...(a.muted !== undefined ? { muted: a.muted } : {}), ...(a.solo !== undefined ? { solo: a.solo } : {}), ...(a.locked !== undefined ? { locked: a.locked } : {}) };
      if (!Object.keys(patch).length) throw new ToolError('Nothing to set.');
      return commit(ctx, [{ type: 'setTrackProps', trackId: t.id, patch }], `Update track ${t.name}`);
    },
  }),
  defineTool({
    name: 'add_marker',
    description: 'Drop a marker (with a label and optional note) on the timeline ruler — to flag places for the user.',
    schema: z.object({ time: timeArg, label: z.string().min(1), note: z.string().optional() }),
    scope: 'edit',
    run: (ctx, a) => commit(ctx, [{ type: 'addMarker', time: parseTime(a.time, ctx.host.sequence().timebase, 'time'), label: a.label, ...(a.note ? { note: a.note } : {}) }], 'Add marker'),
  }),
  defineTool({
    name: 'add_keyframes',
    description: 'Animate a clip property over time. `time` is seconds from the START OF THE CLIP. Properties: opacity (0…1), position.x/position.y (px), scale.x/scale.y, rotation (°), audio.gainDb. Replaces keyframes on that property.',
    schema: z.object({
      clipId: z.string(),
      property: z.enum(KEYFRAME_PROPS),
      keyframes: z.array(z.object({ time: timeArg, value: z.number(), interpolation: z.enum(['linear', 'bezier', 'hold']).default('linear') })).min(1),
    }),
    scope: 'edit',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      const { clip } = clipOf(seq, a.clipId);
      const tb = seq.timebase;
      const keyframes = a.keyframes.map((k) => {
        const time = parseTime(k.time, tb, 'keyframe time');
        if (time < 0 || time > clip.duration) throw new ToolError(`Keyframe time ${(time / tb.rate).toFixed(3)} s is outside the clip (0–${toSeconds(clip.duration, tb)} s).`);
        return { time, value: k.value, interpolation: k.interpolation };
      });
      return commit(ctx, [{ type: 'setKeyframes', clipId: a.clipId, prop: a.property, keyframes }], `Keyframes: ${a.property}`);
    },
  }),
];

/* ------------------------------------------------------------ transitions, effects, captions */

function cutAfter(seq: Sequence, clipId: string): { a: Clip; b: Clip; track: Track } {
  const { clip: a, track } = clipOf(seq, clipId);
  const b = trackItems(track).filter(isClip).find((c) => c.start === a.start + a.duration);
  if (!b) throw new ToolError(`${clipId} has no clip touching its end on ${track.name}; a transition needs two adjacent clips.`);
  return { a, b, track };
}

const captionTrackOf = (seq: Sequence): Track | undefined => seq.tracks.find((t) => t.kind === 'caption');

editTools.push(
  defineTool({
    name: 'add_transition',
    description: `Blend the cut at the END of a clip into the next clip. Types: ${TRANSITIONS.map((t) => t.type).join(', ')}. Needs spare footage past both sides of the cut (handles); the duration is shortened to what exists and the result says so.`,
    schema: z.object({ clipId: z.string().describe('the outgoing clip; the next clip on its track is the incoming one'), type: z.string(), seconds: z.number().min(0.1).max(10).optional(), alignment: z.enum(['center', 'start', 'end']).default('center') }),
    scope: 'edit',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      const def = transitionDef(a.type);
      if (!def) throw new ToolError(`Unknown transition "${a.type}". Available: ${TRANSITIONS.map((t) => t.type).join(', ')}.`);
      const { a: from, b: to, track } = cutAfter(seq, a.clipId);
      const frame = frameTicks(seq.timebase);
      const wanted = Math.round(((a.seconds ?? def.duration) * seq.timebase.rate) / frame) * frame;
      const max = Math.floor(maxTransitionDuration({ env: ctx.host.env }, from, to, a.alignment) / frame) * frame;
      const duration = Math.min(wanted, max);
      if (duration < 2 * frame) throw new ToolError('There is no spare footage at this cut to blend. Trim the clips shorter first so they have handles, or use a different cut.');
      const existing = track.transitions.find((t) => t.betweenClipIds[0] === from.id && t.betweenClipIds[1] === to.id);
      const op: Op = existing ? { type: 'setTransition', id: existing.id, patch: { transitionType: a.type, duration } } : { type: 'addTransition', betweenClipIds: [from.id, to.id], transitionType: a.type, duration, alignment: a.alignment, params: {} };
      return commit(ctx, [op], `${def.label} transition`, { transition: a.type, seconds: toSeconds(duration, seq.timebase), ...(duration < wanted ? { note: 'Shortened to the footage available.' } : {}) });
    },
  }),
  defineTool({
    name: 'remove_transition',
    description: 'Remove the transition at the end of a clip.',
    schema: z.object({ clipId: z.string() }),
    scope: 'edit',
    run: (ctx, a) => {
      const seq = ctx.host.sequence();
      const { clip, track } = clipOf(seq, a.clipId);
      const tr = track.transitions.find((t) => t.betweenClipIds[0] === clip.id);
      if (!tr) throw new ToolError(`No transition after ${a.clipId}.`);
      return commit(ctx, [{ type: 'removeTransition', id: tr.id }], 'Remove transition');
    },
  }),
  defineTool({
    name: 'apply_effect',
    description: 'Add a visual effect to a video clip. Effects: color (exposure, brightness, contrast, saturation, temperature, tint), look (preset 0–4, strength), blur (radius px), sharpen, vignette, sepia, pixelate. Omit params for defaults.',
    schema: z.object({ clipId: z.string(), type: z.string(), params: z.record(z.string(), z.number()).optional() }),
    scope: 'edit',
    run: (ctx, a) => {
      const { clip, track } = clipOf(ctx.host.sequence(), a.clipId);
      if (track.kind !== 'video') throw new ToolError('Effects apply to video clips.');
      const why = validateEffect(a.type, a.params ?? {});
      if (why) throw new ToolError(why);
      const params = { ...defaultParams(a.type), ...(a.params ?? {}) };
      const before = clip.effects.map((e) => e.id);
      const r = commit(ctx, [{ type: 'applyEffect', clipId: clip.id, effect: { type: a.type, params, enabled: true } }], `Apply ${effectDef(a.type)!.label}`);
      const fx = clipOf(ctx.host.sequence(), clip.id).clip.effects.find((e) => !before.includes(e.id));
      return { ...r, effectId: fx?.id };
    },
  }),
  defineTool({
    name: 'set_effect',
    description: 'Change an effect already on a clip (by effectId, or by type when the clip has just one of that type), or switch it on/off.',
    schema: z.object({ clipId: z.string(), effectId: z.string().optional(), type: z.string().optional(), params: z.record(z.string(), z.number()).optional(), enabled: z.boolean().optional() }),
    scope: 'edit',
    run: (ctx, a) => {
      const { clip } = clipOf(ctx.host.sequence(), a.clipId);
      const matches = clip.effects.filter((e) => (a.effectId ? e.id === a.effectId : a.type ? e.type === a.type : false));
      if (matches.length !== 1) throw new ToolError(matches.length ? `${matches.length} effects match; pass effectId (${matches.map((m) => m.id).join(', ')}).` : `No matching effect on ${a.clipId}. It has: ${clip.effects.map((e) => `${e.id} (${e.type})`).join(', ') || 'none'}.`);
      const fx = matches[0]!;
      if (a.params) {
        const why = validateEffect(fx.type, a.params);
        if (why) throw new ToolError(why);
      }
      if (!a.params && a.enabled === undefined) throw new ToolError('Nothing to change.');
      return commit(ctx, [{ type: 'setEffect', clipId: clip.id, effectId: fx.id, ...(a.params ? { params: a.params } : {}), ...(a.enabled !== undefined ? { enabled: a.enabled } : {}) }], `Adjust ${effectDef(fx.type)?.label ?? fx.type}`);
    },
  }),
  defineTool({
    name: 'remove_effect',
    description: 'Remove an effect from a clip (by effectId, or by type when there is only one).',
    schema: z.object({ clipId: z.string(), effectId: z.string().optional(), type: z.string().optional() }),
    scope: 'edit',
    run: (ctx, a) => {
      const { clip } = clipOf(ctx.host.sequence(), a.clipId);
      const matches = clip.effects.filter((e) => (a.effectId ? e.id === a.effectId : a.type ? e.type === a.type : false));
      if (matches.length !== 1) throw new ToolError(`Name exactly one effect (effectId or a unique type). The clip has: ${clip.effects.map((e) => `${e.id} (${e.type})`).join(', ') || 'none'}.`);
      return commit(ctx, [{ type: 'removeEffect', clipId: clip.id, effectId: matches[0]!.id }], 'Remove effect');
    },
  }),
  defineTool({
    name: 'add_captions',
    description: `Create captions from the transcript for clips on the timeline (default: every clip with speech). Follows trims and speed, breaks on sentences and pauses, replaces existing captions. Styles: ${CAPTION_STYLES.map((s) => s.id).join(', ')}.`,
    schema: z.object({ clipIds: z.array(z.string()).optional(), style: z.string().default('default'), maxCharsPerLine: z.number().int().min(10).max(60).default(32), maxLines: z.number().int().min(1).max(3).default(2) }),
    scope: 'edit',
    run: async (ctx, a) => {
      if (!hasCaptionStyle(a.style)) throw new ToolError(`Unknown caption style "${a.style}". Available: ${CAPTION_STYLES.map((s) => s.id).join(', ')}.`);
      let seq = ctx.host.sequence();
      const pool = a.clipIds ? a.clipIds.map((id) => clipOf(seq, id).clip) : seq.tracks.filter((t) => t.kind !== 'caption').flatMap((t) => trackItems(t).filter(isClip));
      const seen = new Set<string>();
      const clips = pool.filter((c) => {
        const key = c.linkGroupId ?? c.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((x, y) => x.start - y.start);
      const drafts: ReturnType<typeof captionsForClip> = [];
      const skipped: string[] = [];
      for (const c of clips) {
        const t = (await ctx.host.analysis(c.mediaId, 'transcript')) as { words: { text: string; startMs: number; endMs: number }[] } | null;
        if (!t) {
          skipped.push(ctx.host.media().find((m) => m.id === c.mediaId)?.name ?? c.mediaId);
          continue;
        }
        drafts.push(...captionsForClip(t.words, c, seq.timebase, { maxCharsPerLine: a.maxCharsPerLine, maxLines: a.maxLines }));
      }
      if (!drafts.length) throw new ToolError(skipped.length ? `No transcript for ${[...new Set(skipped)].join(', ')} (it may still be processing or the transcription engine is not installed).` : 'No speech found in those clips.');
      let track = captionTrackOf(seq);
      if (!track) {
        const r = ctx.host.applyOps([{ type: 'addTrack', kind: 'caption' }], { label: 'Add caption track', origin: `agent:${ctx.role}`, group: ctx.group });
        ctx.onEdit(r.revision);
        seq = ctx.host.sequence();
        track = captionTrackOf(seq);
      }
      if (!track) throw new ToolError('Could not create a caption track.');
      const out = commit(ctx, [{ type: 'setCaptions', trackId: track.id, items: drafts.map((d) => ({ ...d, styleId: a.style })), createdBy: `agent:${ctx.role}` }], `Add ${drafts.length} captions`, { captions: drafts.length, style: a.style, track: track.name });
      return { ...out, ...(skipped.length ? { skipped: [...new Set(skipped)] } : {}) };
    },
  }),
  defineTool({
    name: 'style_captions',
    description: 'Change the style (and optionally the height, 0–1 from the top) of every caption.',
    schema: z.object({ style: z.string(), y: z.number().min(0.05).max(0.95).optional() }),
    scope: 'edit',
    run: (ctx, a) => {
      if (!hasCaptionStyle(a.style)) throw new ToolError(`Unknown caption style "${a.style}". Available: ${CAPTION_STYLES.map((s) => s.id).join(', ')}.`);
      const track = captionTrackOf(ctx.host.sequence());
      const caps = track ? trackItems(track).filter(isCaption) : [];
      if (!caps.length) throw new ToolError('There are no captions yet. Use add_captions first.');
      return commit(ctx, caps.map((c: CaptionItem): Op => ({ type: 'updateCaption', id: c.id, patch: { styleId: a.style, ...(a.y !== undefined ? { position: { x: c.position?.x ?? 0.5, y: a.y } } : {}) } })), 'Caption style', { styled: caps.length });
    },
  }),
);
