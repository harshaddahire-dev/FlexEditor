import type { Media } from '../media';
import type { MediaRef, Timebase } from './types';
import { tbSecondsToTicks } from './units';

/** What the edit engine needs to know about a media file, expressed in the sequence's ticks. */
export function mediaRef(m: Pick<Media, 'id' | 'type' | 'duration' | 'audio'>, tb: Timebase): MediaRef {
  const isImage = m.type === 'image';
  return {
    id: m.id,
    kind: m.type,
    // floor: never claim more media than exists
    duration: isImage ? null : tbSecondsToTicks(m.duration, tb, 'floor'),
    hasVideo: m.type === 'video' || isImage,
    hasAudio: !!m.audio,
  };
}
