import fs from 'node:fs/promises';
import {
  type AudioStreamInfo,
  type FfmpegStatus,
  type Media,
  type ProxyCodec,
  type Rational,
  type VideoStreamInfo,
  toNumber,
} from '@cutroom/core';
import { runText, runBinary } from './proc';
import { renameRetry } from './util';

/** Proxies are capped so the short side is at most this many pixels (1080p landscape / 1080x1920 portrait). */
export const PROXY_MAX_SHORT_SIDE = 1080;

export interface ProxyPlan {
  codec: ProxyCodec;
  width: number;
  height: number;
  fps: Rational;
  gop: number;
  /** -vf filter graph. */
  filter: string;
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
  caps: Pick<FfmpegStatus, 'filters'>,
  codec: ProxyCodec = 'h264',
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
  chain.push(`scale=${width}:${height}:flags=bicubic+accurate_rnd:out_color_matrix=bt709:out_range=tv${inMatrix}`);
  chain.push('setsar=1');
  chain.push('format=yuv420p');

  const gop = Math.max(1, Math.round(toNumber(fps) / 2));
  return { codec, width, height, fps, gop, filter: chain.join(','), warnings };
}

/** Video-only proxy: audio lives in a separate PCM WAV (see `buildAudioProxyArgs`). */
export function buildProxyArgs(src: string, out: string, plan: ProxyPlan): string[] {
  const args = ['-y', '-hide_banner', '-nostdin', '-v', 'error', '-i', src, '-map', '0:v:0', '-an', '-vf', plan.filter, '-fps_mode', 'passthrough'];
  if (plan.codec === 'vp9') {
    // short GOP, no look-ahead / alt-ref reordering: frames come out in presentation order and every GOP is seekable
    args.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '30', '-b:v', '0',
      '-g', String(plan.gop), '-keyint_min', String(plan.gop), '-lag-in-frames', '0', '-auto-alt-ref', '0', '-tag:v', 'vp09');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'superfast', '-crf', '22', '-g', String(plan.gop), '-keyint_min', String(plan.gop), '-sc_threshold', '0', '-bf', '0');
  }
  args.push('-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
  args.push('-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', out);
  return args;
}

export interface AudioProxyPlan {
  channels: number;
  /** Seconds of silence to prepend: how long after the container origin the audio stream starts (never negative). */
  offsetSec: number;
}

/**
 * The audio proxy keeps the container's time origin: if the audio stream starts 21 ms after the first video frame,
 * the WAV opens with 21 ms of silence, so "media time t" means the same thing in the video proxy and the WAV.
 */
export function planAudioProxy(audio: AudioStreamInfo, video: VideoStreamInfo | undefined): AudioProxyPlan {
  const origin = video ? Math.min(toNumber(video.startTime), toNumber(audio.startTime)) : toNumber(audio.startTime);
  return { channels: Math.max(1, Math.min(2, audio.channels)), offsetSec: toNumber(audio.startTime) - origin };
}

export function buildAudioProxyArgs(src: string, out: string, plan: AudioProxyPlan): string[] {
  const args = ['-y', '-hide_banner', '-nostdin', '-v', 'error', '-i', src, '-vn', '-map', '0:a:0'];
  if (plan.offsetSec > 0.0005) args.push('-af', `adelay=${Math.round(plan.offsetSec * 1000)}:all=1`);
  args.push('-c:a', 'pcm_s16le', '-ar', '48000', '-ac', String(plan.channels), '-f', 'wav', '-progress', 'pipe:1', '-nostats', out);
  return args;
}

export interface ProxyRunOptions {
  ffmpegPath: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

async function runWithProgress(ffmpegPath: string, args: string[], tmp: string, out: string, durationSeconds: number, opts: ProxyRunOptions, what: string): Promise<void> {
  try {
    const r = await runBinary(ffmpegPath, args, {
      signal: opts.signal,
      onStdoutLine: (line) => {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        // out_time_ms is (misleadingly) also microseconds in ffmpeg's -progress output
        if (m && durationSeconds > 0) opts.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / durationSeconds));
      },
    });
    if (r.code !== 0) throw new Error(`ffmpeg ${what} failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    await renameRetry(tmp, out);
    opts.onProgress?.(1);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Transcode `src` into the video proxy `out` (via a temp file so a crash never leaves a truncated proxy). */
export async function generateProxy(src: string, out: string, plan: ProxyPlan, durationSeconds: number, opts: ProxyRunOptions): Promise<void> {
  const tmp = out.replace(/\.mp4$/, '.partial.mp4');
  await runWithProgress(opts.ffmpegPath, buildProxyArgs(src, tmp, plan), tmp, out, durationSeconds, opts, 'proxy');
}

/** Decode the audio to 48 kHz PCM WAV. */
export async function generateAudioProxy(src: string, out: string, plan: AudioProxyPlan, durationSeconds: number, opts: ProxyRunOptions): Promise<void> {
  const tmp = out.replace(/\.wav$/, '.partial.wav');
  await runWithProgress(opts.ffmpegPath, buildAudioProxyArgs(src, tmp, plan), tmp, out, durationSeconds, opts, 'audio proxy');
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
