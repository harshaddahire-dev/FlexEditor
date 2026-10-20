import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExportPreset } from '@cutroom/core';
import { runBinary } from '../proc';
import type { VideoGraph } from './video';

export interface RenderOptions {
  ffmpegPath: string;
  graph: VideoGraph;
  preset: ExportPreset;
  outFile: string;
  /** 48 kHz WAV rendered by the browser's OfflineAudioContext (same graph as playback). */
  audioPath?: string;
  workDir: string;
  /** Output size when different from the sequence's. */
  size?: { width: number; height: number };
  onProgress(fraction: number): void;
  signal?: AbortSignal;
}

/** Colour tags: the picture was converted with the Rec.709 matrix, limited range; say so, or players guess. */
export const COLOR_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

export function videoCodecArgs(preset: ExportPreset): string[] {
  switch (preset.video) {
    case 'h264':
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...COLOR_TAGS, '-movflags', '+faststart'];
    case 'vp9':
      return ['-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p', ...COLOR_TAGS];
    case 'prores':
      return ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', ...COLOR_TAGS];
    default:
      return [];
  }
}

export function audioCodecArgs(preset: ExportPreset): string[] {
  switch (preset.audio) {
    case 'aac':
      return ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000'];
    case 'opus':
      return ['-c:a', 'libopus', '-b:a', '192k', '-ar', '48000'];
    default:
      return ['-c:a', 'pcm_s24le', '-ar', '48000'];
  }
}

/** Render the video graph with FFmpeg (and mux the browser's audio) into the final file. */
export async function renderWithFfmpeg(o: RenderOptions): Promise<void> {
  const script = path.join(o.workDir, 'graph.txt');
  const g = o.size && (o.size.width !== 0) ? o.graph.graph.replace(/\[vout\]$/, '[vfull]') + `;\n[vfull]scale=${o.size.width}:${o.size.height}:flags=lanczos[vout]` : o.graph.graph;
  await fs.writeFile(script, g);
  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-stats_period', '0.25'];
  for (const input of o.graph.inputs) args.push(...input);
  const audioIndex = o.graph.inputs.length;
  if (o.audioPath) args.push('-i', o.audioPath);
  args.push('-filter_complex_script', script, '-map', `[${o.graph.out}]`);
  if (o.audioPath) args.push('-map', `${audioIndex}:a:0`);
  args.push('-r', o.graph.fpsRational, '-frames:v', String(Math.max(1, o.graph.frames)), ...videoCodecArgs(o.preset));
  if (o.audioPath) args.push(...audioCodecArgs(o.preset), '-t', String(o.graph.frames / o.graph.fps));
  args.push(o.outFile);

  const total = o.graph.frames / o.graph.fps;
  const res = await runBinary(o.ffmpegPath, args, {
    signal: o.signal,
    onStdoutLine: (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m) o.onProgress(Math.min(0.99, Number(m[1]) / 1e6 / Math.max(total, 0.001)));
    },
  });
  if (res.code !== 0) throw new Error(`FFmpeg could not render this timeline.\n${res.stderr.trim().split('\n').slice(-6).join('\n')}`);
}

/** Mux an elementary video stream produced by the browser's VideoEncoder with the browser-rendered audio. */
export async function muxWebCodecs(o: { ffmpegPath: string; preset: ExportPreset; videoFile: string; videoFormat: 'h264' | 'ivf'; fpsRational: string; frames: number; audioPath?: string; outFile: string; signal?: AbortSignal }): Promise<void> {
  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (o.videoFormat === 'h264') args.push('-framerate', o.fpsRational, '-f', 'h264', '-i', o.videoFile);
  else args.push('-f', 'ivf', '-i', o.videoFile);
  if (o.audioPath) args.push('-i', o.audioPath);
  args.push('-map', '0:v:0');
  if (o.audioPath) args.push('-map', '1:a:0');
  args.push('-c:v', 'copy');
  // the encoder writes no colour description into the stream: add it, so players do not guess
  if (o.videoFormat === 'h264') args.push('-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0');
  if (o.preset.container === 'mp4') args.push('-movflags', '+faststart');
  if (o.audioPath) args.push(...audioCodecArgs(o.preset));
  args.push('-r', o.fpsRational, '-frames:v', String(o.frames), o.outFile);
  const res = await runBinary(o.ffmpegPath, args, { signal: o.signal });
  if (res.code !== 0) throw new Error(`FFmpeg could not mux the encoded video.\n${res.stderr.trim().split('\n').slice(-6).join('\n')}`);
}

/** Audio-only export: whatever the browser rendered, as 24-bit PCM. */
export async function writeAudioOnly(o: { ffmpegPath: string; audioPath: string; outFile: string; signal?: AbortSignal }): Promise<void> {
  const res = await runBinary(o.ffmpegPath, ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', o.audioPath, '-c:a', 'pcm_s24le', '-ar', '48000', o.outFile], { signal: o.signal });
  if (res.code !== 0) throw new Error(`FFmpeg could not write the audio.\n${res.stderr.trim().split('\n').slice(-4).join('\n')}`);
}
