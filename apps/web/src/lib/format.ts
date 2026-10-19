import { framesToTimecode, rational, rescale, toNumber, type Media, type Rational } from '@cutroom/core';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Exact rational seconds → HH:MM:SS:FF at `fps` (drop-frame aware). */
export function formatDuration(seconds: Rational, fps: Rational): string {
  if (seconds.num === 0) return '00:00:00:00';
  const frames = rescale(seconds.num, rational(seconds.den), fps);
  return framesToTimecode(frames, fps);
}

export function formatFps(fps: Rational): string {
  const v = toNumber(fps);
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '');
}

export function describeVideo(m: Media): string {
  if (!m.video) return '';
  const { width, height } = m.video;
  return `${width}×${height}${m.fps ? ` · ${formatFps(m.fps)} fps` : ''}`;
}

export const FPS_PRESETS: { label: string; value: Rational }[] = [
  { label: '23.976', value: rational(24000, 1001) },
  { label: '24', value: rational(24) },
  { label: '25', value: rational(25) },
  { label: '29.97', value: rational(30000, 1001) },
  { label: '30', value: rational(30) },
  { label: '50', value: rational(50) },
  { label: '59.94', value: rational(60000, 1001) },
  { label: '60', value: rational(60) },
];
