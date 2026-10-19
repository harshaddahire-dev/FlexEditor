import { type EditEnv, type Media, type Op, type Sequence, applyOp, isEditError, mediaRef } from '@cutroom/core';

/** The engine's view of the project's media, built from what the client already knows. Same function as the server's. */
export function makeEnv(media: Readonly<Record<string, Media>>, seq: Sequence): EditEnv {
  return { getMedia: (id) => (media[id] ? mediaRef(media[id]!, seq.timebase) : undefined) };
}

/**
 * Run `ops` against a copy of the sequence with the SAME engine the server uses. Returns the reason an edit would be
 * rejected, or null when it is legal — this is how a drag shows a red ghost before the user lets go.
 */
export function dryRun(seq: Sequence, ops: readonly Op[], env: EditEnv): string | null {
  try {
    let s = seq;
    for (const op of ops) s = applyOp(s, op, env).state;
    return null;
  } catch (e) {
    return isEditError(e) ? e.message : (e as Error).message;
  }
}
