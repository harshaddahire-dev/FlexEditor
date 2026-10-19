import { type Media, type MediaRef, type Sequence, mediaRef } from '@cutroom/core';
import { mediaUrl } from '../lib/api';
import { PcmSource } from './pcm';

const cache = new Map<string, { key: string; ready: Promise<PcmSource> }>();

/** The 48 kHz PCM proxy of a media file, opened once and shared by playback and offline rendering. */
export function pcmFor(media: Media): Promise<PcmSource> | null {
  if (!media.audio || !media.audioProxyPath || media.missing) return null;
  const key = `${media.mtimeMs}:${media.audioProxyPath}`;
  const hit = cache.get(media.id);
  if (hit?.key === key) return hit.ready;
  const ready = PcmSource.open(mediaUrl(media.id, 'audio', media.mtimeMs));
  ready.catch(() => cache.get(media.id)?.ready === ready && cache.delete(media.id));
  cache.set(media.id, { key, ready });
  return ready;
}

/** The engine's view of the media bin, in the sequence's ticks. */
export const envOf = (media: Record<string, Media>, seq: Sequence) => ({
  getMedia: (id: string): MediaRef | undefined => (media[id] ? mediaRef(media[id]!, seq.timebase) : undefined),
});
