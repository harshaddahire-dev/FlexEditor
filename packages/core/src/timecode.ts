import { isDropFrameRate, rescale, rational, type Rational } from './time';

/** Whole-number timebase used for timecode counting: 29.97 → 30, 23.976 → 24, 59.94 → 60. */
export function timecodeBase(fps: Rational): number {
  return Math.max(1, Math.round(fps.num / fps.den));
}

const dropCount = (base: number): number => Math.round(base / 15); // 30 → 2, 60 → 4

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/**
 * Frame count → `HH:MM:SS:FF` (or `HH:MM:SS;FF` for drop-frame, which skips frame *labels* — never frames —
 * at the start of every minute except each tenth so 29.97 fps timecode tracks wall-clock time).
 */
export function framesToTimecode(frames: number, fps: Rational, dropFrame = isDropFrameRate(fps)): string {
  if (!Number.isInteger(frames)) throw new TypeError('frames must be an integer');
  const sign = frames < 0 ? '-' : '';
  let n = Math.abs(frames);
  const base = timecodeBase(fps);
  const df = dropFrame && isDropFrameRate(fps);
  if (df) {
    const drop = dropCount(base);
    const perMin = base * 60 - drop;
    const per10Min = base * 600 - drop * 9;
    const tens = Math.floor(n / per10Min);
    const rem = n % per10Min;
    n += drop * 9 * tens;
    if (rem > drop) n += drop * Math.floor((rem - drop) / perMin);
  }
  const ff = n % base;
  const totalSeconds = Math.floor(n / base);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}${df ? ';' : ':'}${pad(ff, base >= 100 ? 3 : 2)}`;
}

/** Inverse of {@link framesToTimecode}. Accepts `:` or `;` before the frame field. Returns null when malformed or invalid. */
export function timecodeToFrames(tc: string, fps: Rational, dropFrame = isDropFrameRate(fps)): number | null {
  const m = /^(-)?(\d+):(\d{2}):(\d{2})[:;.](\d{2,3})$/.exec(tc.trim());
  if (!m) return null;
  const [hh, mm, ss, ff] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const base = timecodeBase(fps);
  if (mm > 59 || ss > 59 || ff >= base) return null;
  const df = dropFrame && isDropFrameRate(fps);
  let frames = ((hh * 60 + mm) * 60 + ss) * base + ff;
  if (df) {
    const drop = dropCount(base);
    // labels :00 and :01 (…:03 at 59.94) do not exist at the start of non-tenth minutes
    if (ss === 0 && ff < drop && mm % 10 !== 0) return null;
    const totalMinutes = hh * 60 + mm;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return m[1] ? -frames : frames;
}

/** Exact rational seconds → timecode at `fps` (rounds to the nearest frame). */
export function secondsToTimecode(seconds: Rational, fps: Rational, dropFrame?: boolean): string {
  return framesToTimecode(rescale(seconds.num, rational(seconds.den), fps), fps, dropFrame);
}
