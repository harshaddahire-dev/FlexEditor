import { type Clip, type Media, type Op, type Sequence, type Track, type TrackItem, frameTicks, isClip, itemEnd, linkGroup, mediaRef, trackItems } from '@cutroom/core';

/** Something the user asked for that cannot be done, phrased for the status line. */
export class CommandError extends Error {}

/** Still images get this much timeline when dropped in. */
export const STILL_SECONDS = 5;

const unlocked = (t: Track): boolean => !t.locked;

export function itemById(seq: Sequence, id: string): TrackItem | undefined {
  for (const t of seq.tracks) if (t.items[id]) return t.items[id];
  return undefined;
}

/** Add every linked partner of the given clips (Premiere's "linked selection"). */
export function expandLinked(seq: Sequence, ids: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const it = itemById(seq, id);
    if (!it) continue;
    out.add(id);
    if (isClip(it)) for (const m of linkGroup(seq, it)) out.add(m.id);
  }
  return [...out];
}

/** Items to the right of `ticks` on one track (or all unlocked tracks). */
export function selectForward(seq: Sequence, trackId: string, ticks: number, allTracks: boolean): string[] {
  const out: string[] = [];
  for (const t of seq.tracks) {
    if (!allTracks && t.id !== trackId) continue;
    for (const i of trackItems(t)) if (itemEnd(i) > ticks) out.push(i.id);
  }
  return out;
}

/** Sorted, de-duplicated cut points of every clip (for Up/Down edit-point navigation). */
export function editPoints(seq: Sequence): number[] {
  const pts = new Set<number>([0]);
  for (const t of seq.tracks) for (const i of Object.values(t.items)) (pts.add(i.start), pts.add(itemEnd(i)));
  return [...pts].sort((a, b) => a - b);
}

/** One representative per link group, so a linked split is requested once (the engine splits the partners with it). */
function primaries(clips: readonly Clip[]): Clip[] {
  const seen = new Set<string>();
  const out: Clip[] = [];
  for (const c of clips) {
    if (c.linkGroupId) {
      if (seen.has(c.linkGroupId)) continue;
      seen.add(c.linkGroupId);
    }
    out.push(c);
  }
  return out;
}

/**
 * Blade: split what is under the playhead — the selection if there is one, otherwise every unlocked track.
 * A linked pair is split with one linked op; if a partner sits on a locked track, only the unlocked clips are cut
 * (the locked track is protected, exactly like locked tracks in other editors).
 */
export function splitAtPlayhead(seq: Sequence, playhead: number, selection: ReadonlySet<string>): Op[] {
  const crossing: Clip[] = [];
  for (const t of seq.tracks.filter(unlocked)) {
    for (const i of trackItems(t)) {
      if (!isClip(i) || !(i.start < playhead && playhead < itemEnd(i))) continue;
      if (selection.size && !selection.has(i.id)) continue;
      crossing.push(i);
    }
  }
  if (!crossing.length) throw new CommandError(selection.size ? 'The selection is not under the playhead.' : 'There is no clip under the playhead.');
  const lockedTrack = new Set(seq.tracks.filter((t) => t.locked).map((t) => t.id));
  const ops: Op[] = [];
  for (const c of primaries(crossing)) {
    const group = linkGroup(seq, c);
    if (group.some((m) => lockedTrack.has(m.trackId))) {
      for (const m of crossing.filter((x) => group.some((g) => g.id === x.id))) ops.push({ type: 'split', clipId: m.id, at: playhead, linked: false });
    } else ops.push({ type: 'split', clipId: c.id, at: playhead });
  }
  return ops;
}

/** Blade at a specific clip (clicked with the blade tool). */
export function splitClipAt(seq: Sequence, clipId: string, at: number): Op[] {
  const it = itemById(seq, clipId);
  if (!it || !isClip(it)) throw new CommandError('That item cannot be split.');
  if (!(it.start < at && at < itemEnd(it))) throw new CommandError('Click inside the clip to split it.');
  return [{ type: 'split', clipId, at }];
}

export function deleteItems(seq: Sequence, ids: readonly string[], ripple: boolean): Op[] {
  if (!ids.length) throw new CommandError('Nothing is selected.');
  const clips = ids.map((id) => itemById(seq, id)).filter((i): i is Clip => !!i && isClip(i));
  const others = ids.filter((id) => !clips.some((c) => c.id === id));
  const ops: Op[] = [];
  if (clips.length) ops.push(ripple ? { type: 'rippleDelete', clipIds: clips.map((c) => c.id), linked: true } : { type: 'delete', itemIds: clips.map((c) => c.id), linked: true });
  if (others.length) ops.push({ type: 'delete', itemIds: others, linked: false });
  return ops;
}

/** Q / W: ripple-trim the clip under the playhead so its start / end meets the playhead. */
export function rippleTrimToPlayhead(seq: Sequence, playhead: number, edge: 'start' | 'end', selection: ReadonlySet<string>): Op[] {
  const candidates: Clip[] = [];
  for (const t of seq.tracks.filter(unlocked)) {
    for (const i of trackItems(t)) if (isClip(i) && i.start < playhead && playhead < itemEnd(i)) candidates.push(i);
  }
  const picked = candidates.find((c) => selection.has(c.id)) ?? candidates.find((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === 'video') ?? candidates[0];
  if (!picked) throw new CommandError('There is no clip under the playhead to trim.');
  return [{ type: 'rippleTrim', clipId: picked.id, edge, to: playhead, linked: true }];
}

export function moveSelection(seq: Sequence, ids: readonly string[], delta: number, opts: { toTrackId?: string; overwrite?: boolean } = {}): Op[] {
  const clips = ids.filter((id) => { const i = itemById(seq, id); return i && isClip(i); });
  if (!clips.length) throw new CommandError('Only clips can be moved.');
  return [{ type: 'move', clipIds: clips, delta, linked: false, mode: opts.overwrite ? 'overwrite' : 'strict', ...(opts.toTrackId ? { toTrackId: opts.toTrackId } : {}) }];
}

/** Insert/overwrite media at `at`. Video goes to the target (or first free) video track with its audio linked underneath. */
export function placeMedia(seq: Sequence, media: readonly Media[], at: number, mode: 'insert' | 'overwrite', targetTrackId?: string): Op[] {
  if (!media.length) throw new CommandError('Nothing to place.');
  const target = targetTrackId ? seq.tracks.find((t) => t.id === targetTrackId) : undefined;
  const firstFree = (kind: Track['kind']) => seq.tracks.find((t) => t.kind === kind && !t.locked);
  const ops: Op[] = [];
  let cursor = at;
  for (const m of media) {
    if (m.missing) throw new CommandError(`${m.name} is missing; relink it first.`);
    const ref = mediaRef(m, seq.timebase);
    const frame = frameTicks(seq.timebase);
    const length = ref.duration ?? STILL_SECONDS * seq.timebase.rate;
    const len = Math.floor(length / frame) * frame || length;
    const clips: Extract<Op, { type: 'insert' }>['clips'] = [];
    if (ref.hasVideo) {
      const vt = target?.kind === 'video' && !target.locked ? target : firstFree('video');
      if (!vt) throw new CommandError('There is no unlocked video track.');
      clips.push({ trackId: vt.id, mediaId: m.id, sourceIn: 0, sourceOut: len, ...(ref.hasAudio ? { link: 'av' } : {}), name: m.name });
    }
    if (ref.hasAudio) {
      const at2 = target?.kind === 'audio' && !target.locked ? target : firstFree('audio');
      if (!at2 && !ref.hasVideo) throw new CommandError('There is no unlocked audio track.');
      if (at2) clips.push({ trackId: at2.id, mediaId: m.id, sourceIn: 0, sourceOut: len, ...(ref.hasVideo ? { link: 'av' } : {}), name: m.name });
    }
    if (clips.length === 1 && clips[0]!.link) delete clips[0]!.link; // a lone clip has nobody to link to
    ops.push({ type: mode, at: cursor, clips });
    cursor += len;
  }
  return ops;
}

export function addMarkerAt(playhead: number, label = 'Marker'): Op[] {
  return [{ type: 'addMarker', time: playhead, label }];
}
