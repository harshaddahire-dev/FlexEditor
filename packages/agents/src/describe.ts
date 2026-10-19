import { type Clip, type Media, type Sequence, type Timebase, frameTicks, isClip, itemEnd, sequenceDuration, toNumber, trackItems } from '@cutroom/core';
import { toSeconds } from './time';

const s = (ticks: number, tb: Timebase): number => toSeconds(ticks, tb);

/** One clip, in the units a model reasons in: seconds (and frames), never raw ticks. */
export function describeClip(c: Clip, seq: Sequence, media: ReadonlyMap<string, Media>, trackName: string): Record<string, unknown> {
  const tb = seq.timebase;
  const f = frameTicks(tb);
  const speed = c.speed.num / c.speed.den;
  return {
    id: c.id,
    track: trackName,
    media: media.get(c.mediaId)?.name ?? c.mediaId,
    mediaId: c.mediaId,
    start: s(c.start, tb),
    end: s(itemEnd(c), tb),
    duration: s(c.duration, tb),
    startFrame: Math.round(c.start / f),
    sourceIn: s(c.sourceIn, tb),
    sourceOut: s(c.sourceIn + c.duration * speed, tb),
    ...(speed !== 1 ? { speed } : {}),
    ...(c.enabled ? {} : { enabled: false }),
    ...(c.linkGroupId ? { linked: c.linkGroupId } : {}),
    ...(c.audio.gainDb ? { gainDb: c.audio.gainDb } : {}),
    ...(c.audio.pan ? { pan: c.audio.pan } : {}),
    ...(c.transform.opacity !== 1 ? { opacity: c.transform.opacity } : {}),
    ...(Object.keys(c.keyframes).length ? { keyframed: Object.keys(c.keyframes) } : {}),
    ...(c.createdBy !== 'user' ? { by: c.createdBy, accepted: c.accepted } : {}),
  };
}

export interface SequenceView {
  name: string;
  fps: number;
  size: string;
  duration: number;
  tracks: { name: string; kind: string; locked: boolean; muted: boolean; clips: number }[];
  clips: Record<string, unknown>[];
  truncated?: string;
}

/** The sequence as the agents see it. `from`/`to` (seconds) and `track` narrow it; output is capped so a huge timeline cannot flood the context. */
export function describeSequence(seq: Sequence, media: Media[], o: { from?: number; to?: number; track?: string; limit?: number } = {}): SequenceView {
  const tb = seq.timebase;
  const byId = new Map(media.map((m) => [m.id, m]));
  const limit = o.limit ?? 150;
  const clips: Record<string, unknown>[] = [];
  let total = 0;
  for (const t of seq.tracks) {
    if (o.track && t.name !== o.track) continue;
    for (const item of trackItems(t)) {
      if (!isClip(item)) continue;
      const a = item.start / tb.rate;
      const b = itemEnd(item) / tb.rate;
      if ((o.from !== undefined && b <= o.from) || (o.to !== undefined && a >= o.to)) continue;
      total++;
      if (clips.length < limit) clips.push(describeClip(item, seq, byId, t.name));
    }
  }
  clips.sort((x, y) => (x.start as number) - (y.start as number) || String(x.track).localeCompare(String(y.track)));
  return {
    name: seq.name,
    fps: Math.round((tb.fps.num / tb.fps.den) * 1000) / 1000,
    size: `${seq.width}x${seq.height}`,
    duration: s(sequenceDuration(seq), tb),
    tracks: seq.tracks.map((t) => ({ name: t.name, kind: t.kind, locked: t.locked, muted: t.muted, clips: Object.keys(t.items).length })),
    clips,
    ...(total > clips.length ? { truncated: `Showing ${clips.length} of ${total} clips; narrow with from/to/track.` } : {}),
  };
}

export function describeMedia(m: Media): Record<string, unknown> {
  const a = m.analysis as Record<string, Record<string, unknown> | undefined>;
  return {
    id: m.id,
    name: m.name,
    type: m.type,
    duration: Math.round(toNumber(m.duration) * 1000) / 1000,
    ...(m.fps ? { fps: Math.round((m.fps.num / m.fps.den) * 1000) / 1000 } : {}),
    ...(m.video ? { resolution: `${m.video.width}x${m.video.height}` } : {}),
    hasAudio: !!m.audio,
    ...(m.missing ? { missing: true } : {}),
    analysis: Object.fromEntries(Object.entries(m.status).filter(([k]) => ['transcript', 'silences', 'scenes', 'beats', 'loudness'].includes(k))),
    ...(a.loudness ? { loudness: a.loudness } : {}),
    ...(a.beats ? { tempo: a.beats } : {}),
    ...(a.silences ? { silences: a.silences } : {}),
    ...(a.scenes ? { scenes: a.scenes } : {}),
    ...(a.transcript ? { transcript: a.transcript } : {}),
  };
}
