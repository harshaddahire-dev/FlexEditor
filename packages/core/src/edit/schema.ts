import { z } from 'zod';

/**
 * Every editing operation as a zod schema: the single source of truth for TypeScript types, runtime validation of
 * untrusted JSON (UI, agents, MCP) and the JSON Schema handed to models as tool definitions.
 */
const ticks = z.number().int().describe('integer ticks of the sequence timebase');
const id = z.string().min(1);
const rationalS = z.object({ num: z.number().int().positive(), den: z.number().int().positive() });
const origin = z.string().regex(/^(user|agent:[a-z0-9_-]+)$/i);
const linked = z.boolean().default(true).describe('also apply to linked clips (default true)');
const edge = z.enum(['start', 'end']);
const paramValue = z.union([z.number(), z.string(), z.boolean()]);
const params = z.record(z.string(), paramValue);
const propPath = z.string().regex(/^[A-Za-z][\w.:-]*$/);

export const NewClipSchema = z.object({
  trackId: id,
  mediaId: id,
  sourceIn: ticks.describe('media time of the first tick'),
  sourceOut: ticks.describe('media time one past the last tick'),
  speed: rationalS.optional(),
  link: z.string().optional().describe('clips in one call sharing this label become a link group'),
  name: z.string().optional(),
  createdBy: origin.optional(),
});

export const KeyframeSchema = z.object({
  time: ticks.describe('ticks from the clip start'),
  value: z.number(),
  interpolation: z.enum(['linear', 'bezier', 'hold']).default('linear'),
  easeIn: z.number().min(0).max(1).optional(),
  easeOut: z.number().min(0).max(1).optional(),
  bezier: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

const CaptionWordSchema = z.object({ text: z.string(), start: ticks, end: ticks });

const transformPatch = z
  .object({
    position: z.object({ x: z.number(), y: z.number() }).partial(),
    scale: z.object({ x: z.number(), y: z.number() }).partial(),
    rotation: z.number(),
    anchor: z.object({ x: z.number(), y: z.number() }).partial(),
    opacity: z.number().min(0).max(1),
    crop: z.object({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() }).partial(),
  })
  .partial();

const audioPatch = z.object({ gainDb: z.number().min(-96).max(24), pan: z.number().min(-1).max(1), fadeIn: ticks.min(0), fadeOut: ticks.min(0) }).partial();

export const OpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('insert'), at: ticks, clips: z.array(NewClipSchema).min(1), ripple: z.enum(['all', 'targets']).default('all') }),
  z.object({ type: z.literal('overwrite'), at: ticks, clips: z.array(NewClipSchema).min(1) }),
  z.object({ type: z.literal('split'), clipId: id, at: ticks, linked }),
  z.object({ type: z.literal('trim'), clipId: id, edge, to: ticks, linked }),
  z.object({ type: z.literal('rippleTrim'), clipId: id, edge, to: ticks, linked, rippleTracks: z.union([z.literal('all'), z.array(id)]).optional() }),
  z.object({ type: z.literal('rollTrim'), leftClipId: id, rightClipId: id, to: ticks, linked }),
  z.object({ type: z.literal('slip'), clipId: id, delta: ticks.describe('source ticks to shift the content by'), linked }),
  z.object({ type: z.literal('slide'), clipId: id, delta: ticks, linked }),
  z.object({
    type: z.literal('move'),
    clipIds: z.array(id).min(1),
    delta: ticks.optional(),
    to: ticks.optional().describe('new start of the first clip (alternative to delta)'),
    toTrackId: id.optional(),
    linked,
    mode: z.enum(['strict', 'overwrite']).default('strict'),
  }),
  z.object({ type: z.literal('delete'), itemIds: z.array(id).min(1), linked }),
  z.object({ type: z.literal('rippleDelete'), clipIds: z.array(id).min(1), linked }),
  z.object({
    type: z.literal('removeRange'),
    start: ticks,
    end: ticks,
    trackIds: z.array(id).optional().describe('default: every unlocked track'),
    ripple: z.boolean().default(true),
    snap: z.enum(['inward', 'nearest', 'outward']).default('inward'),
  }),
  z.object({ type: z.literal('setSpeed'), clipId: id, speed: rationalS, linked, ripple: z.boolean().default(false) }),
  z.object({
    type: z.literal('setClipProps'),
    clipId: id,
    patch: z.object({ name: z.string(), enabled: z.boolean(), transform: transformPatch, audio: audioPatch }).partial(),
    linked: z.boolean().default(false),
  }),
  z.object({ type: z.literal('link'), clipIds: z.array(id).min(2) }),
  z.object({ type: z.literal('unlink'), clipIds: z.array(id).min(1) }),
  z.object({ type: z.literal('accept'), itemIds: z.array(id).min(1) }),

  z.object({ type: z.literal('addKeyframe'), clipId: id, prop: propPath, keyframe: KeyframeSchema }),
  z.object({ type: z.literal('removeKeyframe'), clipId: id, prop: propPath, time: ticks }),
  z.object({ type: z.literal('setKeyframes'), clipId: id, prop: propPath, keyframes: z.array(KeyframeSchema) }),

  z.object({
    type: z.literal('addTransition'),
    betweenClipIds: z.tuple([id, id]),
    transitionType: z.string().min(1),
    duration: ticks.positive(),
    alignment: z.enum(['center', 'start', 'end']).default('center'),
    params: params.default({}),
  }),
  z.object({
    type: z.literal('setTransition'),
    id,
    patch: z.object({ transitionType: z.string(), duration: ticks.positive(), alignment: z.enum(['center', 'start', 'end']), params }).partial(),
  }),
  z.object({ type: z.literal('removeTransition'), id }),

  z.object({
    type: z.literal('applyEffect'),
    clipId: id,
    effect: z.object({ type: z.string().min(1), params: params.default({}), enabled: z.boolean().default(true) }),
  }),
  z.object({ type: z.literal('setEffect'), clipId: id, effectId: id, params: params.optional(), enabled: z.boolean().optional() }),
  z.object({ type: z.literal('removeEffect'), clipId: id, effectId: id }),
  z.object({ type: z.literal('reorderEffect'), clipId: id, effectId: id, toIndex: z.number().int().min(0) }),

  z.object({
    type: z.literal('addCaption'),
    trackId: id,
    start: ticks,
    duration: ticks.positive(),
    words: z.array(CaptionWordSchema),
    styleId: z.string().default('default'),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    createdBy: origin.optional(),
  }),
  z.object({
    type: z.literal('updateCaption'),
    id,
    patch: z.object({ start: ticks, duration: ticks.positive(), words: z.array(CaptionWordSchema), styleId: z.string(), position: z.object({ x: z.number(), y: z.number() }) }).partial(),
  }),
  z.object({
    type: z.literal('setCaptions'),
    trackId: id,
    items: z.array(z.object({ start: ticks, duration: ticks.positive(), words: z.array(CaptionWordSchema), styleId: z.string().default('default'), position: z.object({ x: z.number(), y: z.number() }).optional() })),
    createdBy: origin.optional(),
  }),

  z.object({ type: z.literal('addTrack'), kind: z.enum(['video', 'audio', 'caption', 'graphics']), name: z.string().optional(), index: z.number().int().min(0).optional() }),
  z.object({ type: z.literal('removeTrack'), trackId: id, force: z.boolean().default(false) }),
  z.object({
    type: z.literal('setTrackProps'),
    trackId: id,
    patch: z.object({ name: z.string(), locked: z.boolean(), muted: z.boolean(), solo: z.boolean(), height: z.number().int().min(16).max(400), crossfadeMs: z.number().min(0).max(1000) }).partial(),
  }),
  z.object({ type: z.literal('moveTrack'), trackId: id, toIndex: z.number().int().min(0) }),

  z.object({ type: z.literal('addMarker'), time: ticks.min(0), label: z.string(), note: z.string().optional(), color: z.string().optional() }),
  z.object({ type: z.literal('setMarker'), id, patch: z.object({ time: ticks.min(0), label: z.string(), note: z.string(), color: z.string() }).partial() }),
  z.object({ type: z.literal('removeMarker'), id }),
  z.object({ type: z.literal('setSequenceProps'), patch: z.object({ name: z.string(), width: z.number().int().min(16), height: z.number().int().min(16) }).partial() }),
]);

/** What callers write (defaults optional). */
export type Op = z.input<typeof OpSchema>;
/** What handlers receive (defaults applied). */
export type ParsedOp = z.output<typeof OpSchema>;
export type OpType = ParsedOp['type'];
export type NewClip = z.output<typeof NewClipSchema>;
export type OpOf<T extends OpType> = Extract<ParsedOp, { type: T }>;

export const OP_TYPES = OpSchema.options.map((o) => o.shape.type.value) as OpType[];
