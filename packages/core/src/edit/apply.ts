import { type Draft, type Patch, applyPatches, enablePatches, produceWithPatches } from 'immer';
import { makeCtx, type Ctx } from './ctx';
import { EditError } from './errors';
import { normalize } from './normalize';
import * as clips from './ops/clips';
import * as misc from './ops/misc';
import { type Op, type OpType, type ParsedOp, OpSchema } from './schema';
import type { EditEnv, Sequence } from './types';

enablePatches();

type Handler<T extends OpType> = (ctx: Ctx, op: Extract<ParsedOp, { type: T }>) => void;
const HANDLERS: { [T in OpType]: Handler<T> } = {
  insert: clips.insert,
  overwrite: clips.overwrite,
  split: clips.split,
  trim: clips.trim,
  rippleTrim: clips.rippleTrim,
  rollTrim: clips.rollTrim,
  slip: clips.slip,
  slide: clips.slide,
  move: clips.move,
  delete: clips.deleteItems,
  rippleDelete: clips.rippleDelete,
  removeRange: clips.removeRange,
  setSpeed: clips.setSpeed,
  setClipProps: clips.setClipProps,
  link: clips.link,
  unlink: clips.unlink,
  accept: clips.accept,
  addKeyframe: misc.addKeyframe,
  removeKeyframe: misc.removeKeyframe,
  setKeyframes: misc.setKeyframes,
  addTransition: misc.addTransition,
  setTransition: misc.setTransition,
  removeTransition: misc.removeTransition,
  applyEffect: misc.applyEffect,
  setEffect: misc.setEffect,
  removeEffect: misc.removeEffect,
  reorderEffect: misc.reorderEffect,
  addCaption: misc.addCaption,
  updateCaption: misc.updateCaption,
  setCaptions: misc.setCaptions,
  addTrack: misc.addTrack,
  removeTrack: misc.removeTrack,
  setTrackProps: misc.setTrackProps,
  moveTrack: misc.moveTrack,
  addMarker: misc.addMarker,
  setMarker: misc.setMarker,
  removeMarker: misc.removeMarker,
  setSequenceProps: misc.setSequenceProps,
};

export interface OpResult {
  /** The operation after schema validation and defaults. */
  op: ParsedOp;
  state: Sequence;
  /** Applying these to the previous state yields `state`. */
  patches: Patch[];
  /** Applying these to `state` restores the previous state exactly. */
  inverse: Patch[];
}

/** Validate untrusted JSON as an operation (applies schema defaults). */
export function parseOp(raw: unknown): ParsedOp {
  const r = OpSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? ` at "${issue.path.join('.')}"` : '';
    throw new EditError('invalid', `Invalid operation${where}: ${issue?.message ?? 'bad shape'}`, { issues: r.error.issues });
  }
  return r.data;
}

/**
 * The edit primitive: `(state, op) → { state, inverse }`. Pure and deterministic (ids come from a counter in the
 * state). Throws `EditError` — leaving the input untouched — if the operation is illegal.
 */
export function applyOp(seq: Sequence, rawOp: Op | ParsedOp, env: EditEnv): OpResult {
  const op = parseOp(rawOp);
  const [state, patches, inverse] = produceWithPatches(seq, (draft: Draft<Sequence>) => {
    const ctx = makeCtx(draft as Sequence, env);
    (HANDLERS[op.type] as Handler<OpType>)(ctx, op);
    normalize(ctx);
  });
  return { op, state, patches, inverse };
}

export { applyPatches };
export type { Patch };
