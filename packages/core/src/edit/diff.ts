import { trackItems } from './query';
import { type Sequence, type Ticks, type TrackItem, isClip } from './types';

export interface DiffItem {
  id: string;
  trackId: string;
  trackName: string;
  kind: 'clip' | 'caption';
  name: string;
  start: Ticks;
  duration: Ticks;
}

export interface DiffChange {
  before: DiffItem;
  after: DiffItem;
  /** What changed: position, length, source range, speed, track or properties. */
  what: ('moved' | 'trimmed' | 'retimed' | 'track' | 'props')[];
}

export interface SequenceDiff {
  added: DiffItem[];
  removed: DiffItem[];
  changed: DiffChange[];
}

const view = (seq: Sequence): Map<string, { item: TrackItem; trackName: string }> => {
  const m = new Map<string, { item: TrackItem; trackName: string }>();
  for (const t of seq.tracks) for (const item of trackItems(t)) m.set(item.id, { item, trackName: t.name });
  return m;
};

const brief = (item: TrackItem, trackName: string): DiffItem => ({
  id: item.id,
  trackId: item.trackId,
  trackName,
  kind: item.kind,
  name: isClip(item) ? (item.name ?? item.mediaId) : item.words.map((w) => w.text).join(' ').slice(0, 40) || 'Caption',
  start: item.start,
  duration: item.duration,
});

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What an edit (or a whole agent run) did, item by item: added, removed, and changed — with the reason. Splits show up
 * as one changed (trimmed) item plus added pieces, which is exactly how an editor reads them. Used for the review
 * overlay ("ghost diff") and for the summary card.
 */
export function diffSequences(before: Sequence, after: Sequence): SequenceDiff {
  const a = view(before);
  const b = view(after);
  const out: SequenceDiff = { added: [], removed: [], changed: [] };
  for (const [id, { item, trackName }] of b) {
    const old = a.get(id);
    if (!old) {
      out.added.push(brief(item, trackName));
      continue;
    }
    const what: DiffChange['what'] = [];
    if (old.item.trackId !== item.trackId) what.push('track');
    if (old.item.start !== item.start && old.item.duration === item.duration) what.push('moved');
    else if (old.item.duration !== item.duration || old.item.start !== item.start) what.push('trimmed');
    if (isClip(old.item) && isClip(item)) {
      if (old.item.sourceIn !== item.sourceIn && !what.includes('trimmed') && !what.includes('moved')) what.push('trimmed');
      if (old.item.speed.num * item.speed.den !== item.speed.num * old.item.speed.den) what.push('retimed');
      const strip = (c: typeof item) => ({ ...c, start: 0, duration: 0, sourceIn: 0, speed: 0, trackId: '', accepted: true, linkGroupId: '' });
      if (!sameJson(strip(old.item), strip(item))) what.push('props');
    } else if (!sameJson({ ...old.item, start: 0, duration: 0, trackId: '', accepted: true }, { ...item, start: 0, duration: 0, trackId: '', accepted: true })) what.push('props');
    if (what.length) out.changed.push({ before: brief(old.item, old.trackName), after: brief(item, trackName), what });
  }
  for (const [id, { item, trackName }] of a) if (!b.has(id)) out.removed.push(brief(item, trackName));
  const byStart = (x: DiffItem, y: DiffItem) => x.start - y.start || x.id.localeCompare(y.id);
  out.added.sort(byStart);
  out.removed.sort(byStart);
  out.changed.sort((x, y) => byStart(x.after, y.after));
  return out;
}

export const diffIsEmpty = (d: SequenceDiff): boolean => !d.added.length && !d.removed.length && !d.changed.length;

/** "+3 clips · −1 clip · 2 changed", for chat cards. */
export function diffSummary(d: SequenceDiff): string {
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (d.added.length) parts.push(`+${n(d.added.length, 'item')}`);
  if (d.removed.length) parts.push(`−${n(d.removed.length, 'item')}`);
  if (d.changed.length) parts.push(`${d.changed.length} changed`);
  return parts.join(' · ') || 'No changes';
}

