import type { BinaryStatus, FfmpegStatus } from '@cutroom/core';
import { runText } from './proc';

const WANTED_ENCODERS = ['libx264', 'libx265', 'aac', 'libopus', 'prores_ks'] as const;
const WANTED_FILTERS = [
  'zscale',
  'tonemap',
  'yadif',
  'silencedetect',
  'scdet',
  'ebur128',
  'loudnorm',
  'aevalsrc',
  'showinfo',
] as const;

/** Encoders/filters without which the editor cannot do its core job. */
const REQUIRED_ENCODERS = ['libx264', 'aac'];
const REQUIRED_FILTERS = ['silencedetect', 'ebur128'];

export function parseVersion(banner: string): { version: string; major: number; minor: number } | null {
  const m = /(?:ffmpeg|ffprobe) version\s+(\S+)/.exec(banner);
  if (!m) return null;
  const version = m[1]!;
  const n = /^n?(\d+)\.(\d+)/.exec(version);
  // Git builds look like "N-117000-gabcdef" or "2024-05-01-git-..." — assume current.
  if (!n) return { version, major: 99, minor: 0 };
  return { version, major: Number(n[1]), minor: Number(n[2]) };
}

async function binary(path: string): Promise<BinaryStatus | null> {
  try {
    const r = await runText(path, ['-version']);
    if (r.code !== 0) return null;
    const v = parseVersion(r.stdout.split('\n')[0] ?? '');
    return v ? { path, ...v } : null;
  } catch {
    return null;
  }
}

export function installHints(platform: string): string[] {
  switch (platform) {
    case 'win32':
      return [
        'winget install Gyan.FFmpeg',
        'or: choco install ffmpeg',
        'Then restart the terminal, or set FFMPEG_PATH / FFPROBE_PATH to the full executable paths.',
      ];
    case 'darwin':
      return ['brew install ffmpeg', 'Then restart the server, or set FFMPEG_PATH / FFPROBE_PATH.'];
    default:
      return [
        'sudo apt install ffmpeg   (Debian / Ubuntu)',
        'sudo dnf install ffmpeg   (Fedora, with RPM Fusion)',
        'Then restart the server, or set FFMPEG_PATH / FFPROBE_PATH.',
      ];
  }
}

export async function checkFfmpeg(ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe'): Promise<FfmpegStatus> {
  const [ffmpeg, ffprobe] = await Promise.all([binary(ffmpegPath), binary(ffprobePath)]);
  const problems: string[] = [];
  const warnings: string[] = [];
  const encoders: Record<string, boolean> = Object.fromEntries(WANTED_ENCODERS.map((e) => [e, false]));
  const filters: Record<string, boolean> = Object.fromEntries(WANTED_FILTERS.map((f) => [f, false]));

  if (!ffmpeg) problems.push(`ffmpeg was not found (looked for "${ffmpegPath}").`);
  if (!ffprobe) problems.push(`ffprobe was not found (looked for "${ffprobePath}").`);

  if (ffmpeg) {
    if (ffmpeg.major < 5 || (ffmpeg.major === 5 && ffmpeg.minor < 1)) {
      problems.push(`ffmpeg ${ffmpeg.version} is too old; 5.1 or newer is required.`);
    }
    const [enc, fil] = await Promise.all([
      runText(ffmpegPath, ['-hide_banner', '-encoders']).catch(() => null),
      runText(ffmpegPath, ['-hide_banner', '-filters']).catch(() => null),
    ]);
    for (const line of enc?.stdout.split('\n') ?? []) {
      const m = /^\s[VAS][\w.]{5}\s(\S+)/.exec(line);
      if (m && m[1]! in encoders) encoders[m[1]!] = true;
    }
    for (const line of fil?.stdout.split('\n') ?? []) {
      const m = /^\s[\w.]{3}\s(\S+)/.exec(line);
      if (m && m[1]! in filters) filters[m[1]!] = true;
    }
    for (const e of REQUIRED_ENCODERS) if (!encoders[e]) problems.push(`ffmpeg is missing the "${e}" encoder.`);
    for (const f of REQUIRED_FILTERS) if (!filters[f]) problems.push(`ffmpeg is missing the "${f}" filter.`);
    if (!encoders.libx265) warnings.push('No libx265 encoder: H.265 export is unavailable.');
    if (!encoders.prores_ks) warnings.push('No prores_ks encoder: ProRes export is unavailable.');
    if (!encoders.libopus) warnings.push('No libopus encoder: Opus audio export is unavailable.');
    if (!filters.zscale) warnings.push('No zscale filter: HDR sources cannot be tone-mapped and will look washed out.');
    if (!filters.scdet) warnings.push('No scdet filter: scene detection will use a slower fallback.');
  }

  return {
    ok: problems.length === 0,
    ffmpeg,
    ffprobe,
    encoders,
    filters,
    problems,
    warnings,
    platform: process.platform,
    installHints: problems.length ? installHints(process.platform) : [],
  };
}
