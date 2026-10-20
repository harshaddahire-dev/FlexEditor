import { type Timebase, framesToTimecode, frameTicks, roundTo } from '@cutroom/core';
import { ToolError } from './types';

/**
 * Times from a model arrive in whatever form it finds natural: seconds (`12.5`, `"12.5"`, `"12.5s"`), `m:ss.f`, or
 * timecode `HH:MM:SS:FF`. They become ticks on the frame grid; the engine does the rest of the validation.
 */
export function parseTime(v: unknown, tb: Timebase, what = 'time'): number {
  const frame = frameTicks(tb);
  const fps = tb.fps.num / tb.fps.den;
  let seconds: number;
  if (typeof v === 'number' && Number.isFinite(v)) seconds = v;
  else if (typeof v === 'string') {
    const s = v.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(\d+):(\d{1,2}):(\d{1,2})[:;](\d{1,3})$/.exec(s))) {
      const frames = Number(m[4]);
      seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frames / Math.round(fps);
    } else if ((m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s))) seconds = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    else if ((m = /^(-?\d+(?:\.\d+)?)\s*(s|sec|seconds)?$/.exec(s))) seconds = Number(m[1]);
    else if ((m = /^(-?\d+(?:\.\d+)?)\s*ms$/.exec(s))) seconds = Number(m[1]) / 1000;
    else if ((m = /^(\d+)\s*f(?:rames?)?$/i.exec(s))) seconds = Number(m[1]) / fps;
    else throw new ToolError(`Cannot read ${what} "${v}". Use seconds (12.5), m:ss.f (1:02.5) or timecode (00:01:02:15).`);
  } else throw new ToolError(`${what} must be a number of seconds or a timecode string.`);
  if (!Number.isFinite(seconds)) throw new ToolError(`${what} is not a finite number.`);
  return Math.round(roundTo(seconds * tb.rate, frame));
}

/** `12.500 s · 00:00:12:15 · frame 375` — what a model needs to confirm it read a position correctly. */
export function describeTime(ticks: number, tb: Timebase): string {
  const frames = Math.round(ticks / frameTicks(tb));
  return `${(ticks / tb.rate).toFixed(3)} s · ${framesToTimecode(frames, tb.fps)}`;
}

export const toSeconds = (ticks: number, tb: Timebase): number => Math.round((ticks / tb.rate) * 1000) / 1000;
