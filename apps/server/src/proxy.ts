import fs from 'node:fs/promises';
import {
  type FfmpegStatus,
  type Media,
  type Rational,
  type VideoStreamInfo,
  toNumber,
} from '@cutroom/core';
import { runText, runBinary } from './proc';

/** Proxies are capped so the short side is at most this many pixels (1080p landscape / 1080x1920 portrait). */
export const PROXY_MAX_SHORT_SIDE = 1080;

export interface ProxyPlan {
  width: number;
  height: number;
  fps: Rational;
  gop: number;
  /** -vf filter graph. */
  filter: string;
  audioChannels: number;
  warnings: string[];
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

export function proxyDimensions(displayW: number, displayH: number): { width: number; height: number } {
  const scale = Math.min(1, PROXY_MAX_SHORT_SIDE / Math.min(displayW, displayH));
  return { width: even(displayW * scale), height: even(displayH * scale) };
}

/** The tone-map chain used for PQ/HLG sources (needs ffmpeg's zscale filter). */
const HDR_TONEMAP = [
  'zscale=t=linear:npl=100',
  'format=gbrpf32le',
  'zscale=p=bt709',
  'tonemap=tonemap=hable:desat=0',
  'zscale=t=bt709:m=bt709:r=tv',
].join(',');

/**
 * Decide how to turn a source into an edit proxy: constant frame rate, square pixels,
 * rotation applied, BT.709 limited range, 8-bit 4:2:0, short side ≤ 1080.
 */
export function planProxy(
  video: VideoStreamInfo,
  audioChannels: number,
  caps: Pick<FfmpegStatus, 'filters'>,
): ProxyPlan {
  const warnings: string[] = [];
  const { width, height } = proxyDimensions(video.width, video.height);
  const fps = video.fps;
  const chain: string[] = [];

  if (video.interlaced) chain.push('yadif=mode=send_frame:parity=auto:deint=all');

  if (video.hdr) {
    if (caps.filters.zscale && caps.filters.tonemap) chain.push(HDR_TONEMAP);
    else warnings.push('HDR source could not be tone-mapped (ffmpeg lacks zscale); proxy colours will look washed out.');
  }

  // Constant-frame-rate conform. `fps` duplicates/drops to the nearest tick, keeping the start offset.
  chain.push(`fps=${fps.num}/${fps.den}:round=near`);

  // Single scale step: pixel-aspect + rotation already folded into width/height; convert colour to BT.709 limited.
  const untagged = !video.colorSpace;
  const inMatrix = untagged && !video.hdr ? `:in_color_matrix=${video.height >= 720 ? 'bt709' : 'bt601'}` : '';
  chain.push(`scale=${width}:${height}:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv${inMatrix}`);
  chain.push('setsar=1');
  chain.push('format=yuv420p');

  const gop = Math.max(1, Math.round(toNumber(fps) / 2));
  return {
    width,
    height,
    fps,
    gop,
    filter: chain.join(','),
    audioChannels: Math.min(2, audioChannels),
    warnings,
  };
}

export function buildProxyArgs(src: string, out: string, plan: ProxyPlan, hasAudio: boolean): string[] {
  const args = [
    '-y', '-hide_banner', '-nostdin', '-v', 'error',
    '-i', src,
    '-map', '0:v:0',
  ];
  if (hasAudio) args.push('-map', '0:a:0');
  args.push(
    '-vf', plan.filter,
    '-fps_mode', 'passthrough', // the fps filter already produced CFR; don't let the muxer re-time
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-g', String(plan.gop), '-keyint_min', String(plan.gop), '-sc_threshold', '0', '-bf', '0',
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  );
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', String(Math.max(1, plan.audioChannels)));
  args.push('-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', out);
  return args;
}

export interface ProxyRunOptions {
  ffmpegPath: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Transcode `src` into `out` (via a temp file so a crash never leaves a truncated proxy). */
export async function generateProxy(
  src: string,
  out: string,
  plan: ProxyPlan,
  hasAudio: boolean,
  durationSeconds: number,
  opts: ProxyRunOptions,
): Promise<void> {
  const tmp = out.replace(/\.mp4$/, '.partial.mp4');
  const args = buildProxyArgs(src, tmp, plan, hasAudio);
  try {
    const r = await runBinary(opts.ffmpegPath, args, {
      signal: opts.signal,
      onStdoutLine: (line) => {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && durationSeconds > 0) {
          // out_time_ms is (misleadingly) also microseconds in ffmpeg's -progress output.
          opts.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / durationSeconds));
        }
      },
    });
    if (r.code !== 0) throw new Error(`ffmpeg proxy failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    await fs.rename(tmp, out);
    opts.onProgress?.(1);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export interface PosterOptions {
  ffmpegPath: string;
  signal?: AbortSignal;
}

/** Poster frame (JPEG, 320 px on the long side) used for the bin thumbnail. */
export async function generatePoster(
  src: string,
  out: string,
  media: Pick<Media, 'type' | 'duration' | 'video'>,
  opts: PosterOptions,
): Promise<void> {
  const v = media.video;
  const dw = v?.width ?? 320;
  const dh = v?.height ?? 180;
  const k = 320 / Math.max(dw, dh);
  const w = even(dw * k);
  const h = even(dh * k);
  const seek = media.type === 'video' ? Math.min(1, toNumber(media.duration) * 0.1) : 0;
  const args = ['-y', '-hide_banner', '-nostdin', '-v', 'error'];
  if (seek > 0) args.push('-ss', seek.toFixed(3));
  args.push('-i', src, '-frames:v', '1', '-vf', `scale=${w}:${h}:out_color_matrix=bt709:out_range=pc,setsar=1`, '-q:v', '4', out);
  const r = await runText(opts.ffmpegPath, args, { signal: opts.signal });
  if (r.code !== 0) throw new Error(`poster failed: ${r.stderr.trim().split('\n').pop() ?? ''}`);
}
