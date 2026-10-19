import path from 'node:path';
import {
  type AudioStreamInfo,
  type ColorRange,
  type Media,
  type MediaType,
  type Rational,
  type VideoStreamInfo,
  IMAGE_EXTENSIONS,
  parseDecimal,
  parseRational,
  rational,
  secondsToTicks,
  snapFps,
  toNumber,
} from '@cutroom/core';
import { runText } from './proc';
import { analyzeFrameTiming, type FrameTimingReport } from './timing';

/* ---- the subset of ffprobe JSON we read ---- */

export interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  time_base?: string;
  start_time?: string;
  duration?: string;
  nb_frames?: string;
  bits_per_raw_sample?: string;
  field_order?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

export interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; start_time?: string };
}

export type ProbedMedia = Pick<
  Media,
  'type' | 'duration' | 'fps' | 'audioChannels' | 'video' | 'audio' | 'container' | 'warnings'
>;

const IMAGE_CONTAINERS = new Set(['image2', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'bmp_pipe', 'tiff_pipe', 'gif']);

function normaliseRotation(stream: FfprobeStream): 0 | 90 | 180 | 270 {
  let ccw: number | undefined;
  for (const sd of stream.side_data_list ?? []) {
    if (sd.side_data_type === 'Display Matrix' && typeof sd.rotation === 'number') ccw = sd.rotation;
  }
  // ffprobe reports counter-clockwise degrees needed for correct display; legacy `rotate` tag is clockwise.
  let cw = 0;
  if (ccw !== undefined) cw = -ccw;
  else if (stream.tags?.rotate) cw = Number(stream.tags.rotate) || 0;
  const n = ((Math.round(cw / 90) * 90) % 360 + 360) % 360;
  return n as 0 | 90 | 180 | 270;
}

function bitDepth(stream: FfprobeStream): number {
  const raw = Number(stream.bits_per_raw_sample);
  if (raw > 0) return raw;
  const m = /(\d+)(?:le|be)$/.exec(stream.pix_fmt ?? '');
  return m ? Number(m[1]) : 8;
}

function colorRange(stream: FfprobeStream): ColorRange {
  if (stream.color_range === 'pc') return 'full';
  if (stream.color_range === 'tv') return 'limited';
  if (stream.pix_fmt?.startsWith('yuvj')) return 'full';
  return stream.color_range ? 'unknown' : 'limited';
}

const known = (v: string | undefined): string | undefined => (v && v !== 'unknown' && v !== 'reserved' ? v : undefined);

/** Display size: pixel aspect ratio folded into width (or height when SAR < 1), then rotation applied. */
export function displaySize(codedW: number, codedH: number, sar: Rational, rotation: number): { width: number; height: number } {
  const s = toNumber(sar);
  let w = codedW;
  let h = codedH;
  if (s > 1) w = Math.round(codedW * s);
  else if (s < 1) h = Math.round(codedH / s);
  return rotation === 90 || rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

function chooseFps(stream: FfprobeStream, timing: FrameTimingReport | null): { fps: Rational; vfr: boolean; avg: Rational | null } {
  const r = parseRational(stream.r_frame_rate);
  const avg = parseRational(stream.avg_frame_rate);
  let vfr: boolean;
  if (timing && timing.count >= 3) {
    vfr = timing.vfr;
  } else if (r && avg && toNumber(avg) > 0) {
    // No packet data: fall back to the classic r_frame_rate vs avg_frame_rate disagreement.
    vfr = Math.abs(toNumber(r) - toNumber(avg)) / toNumber(avg) > 0.01;
  } else {
    vfr = false;
  }
  const measured = timing?.avgFps ?? (avg ? toNumber(avg) : r ? toNumber(r) : 25);
  if (vfr) return { fps: snapFps(measured), vfr, avg };
  // CFR: trust r_frame_rate unless it is a container artefact (e.g. 1000/1 from Matroska).
  const candidate = r && toNumber(r) > 0 && toNumber(r) <= 240 ? r : avg && toNumber(avg) > 0 ? avg : null;
  return { fps: candidate ?? snapFps(measured), vfr, avg };
}

/** Turn raw ffprobe output (+ optional packet timing) into the Media fields the editor needs. */
export function interpretProbe(json: FfprobeJson, timing: FrameTimingReport | null, filePath: string): ProbedMedia {
  const warnings: string[] = [];
  const streams = json.streams ?? [];
  const container = json.format?.format_name;
  const ext = path.extname(filePath).toLowerCase();
  const videoStream = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const formatDuration = parseDecimal(json.format?.duration) ?? rational(0);
  const imageContainer = container?.split(',').some((c) => IMAGE_CONTAINERS.has(c)) ?? false;
  const isImage = !!videoStream && !audioStream && (IMAGE_EXTENSIONS.has(ext) || imageContainer);
  if (!videoStream && !audioStream) throw new Error('No audio or video streams found');

  const type: MediaType = isImage ? 'image' : videoStream ? 'video' : 'audio';

  let video: VideoStreamInfo | undefined;
  let fps: Rational | undefined;
  if (videoStream) {
    const codedWidth = videoStream.width ?? 0;
    const codedHeight = videoStream.height ?? 0;
    const sar = parseRational(videoStream.sample_aspect_ratio?.replace(':', '/')) ?? rational(1);
    const sarOk = sar.num > 0 ? sar : rational(1);
    const rotation = normaliseRotation(videoStream);
    const size = displaySize(codedWidth, codedHeight, sarOk, rotation);
    const choice = chooseFps(videoStream, isImage ? null : timing);
    fps = isImage ? undefined : choice.fps;
    const transfer = known(videoStream.color_transfer);
    const hdr = transfer === 'smpte2084' || transfer === 'arib-std-b67';
    const interlaced = !!videoStream.field_order && !['progressive', 'unknown'].includes(videoStream.field_order);
    const nbFrames = Number(videoStream.nb_frames);
    video = {
      codec: videoStream.codec_name ?? 'unknown',
      profile: videoStream.profile,
      pixFmt: videoStream.pix_fmt,
      bitDepth: bitDepth(videoStream),
      codedWidth,
      codedHeight,
      width: size.width,
      height: size.height,
      rotation,
      sar: sarOk,
      fps: choice.fps,
      avgFps: choice.avg,
      frameCount: timing?.count && timing.count > 0 ? timing.count : Number.isFinite(nbFrames) && nbFrames > 0 ? nbFrames : null,
      vfr: choice.vfr,
      interlaced,
      colorRange: colorRange(videoStream),
      colorSpace: known(videoStream.color_space),
      colorTransfer: transfer,
      colorPrimaries: known(videoStream.color_primaries),
      hdr,
      startTime: parseDecimal(videoStream.start_time) ?? rational(0),
    };
    if (!isImage && choice.vfr) {
      warnings.push(
        `Variable frame rate source (≈${toNumber(choice.fps).toFixed(3)} fps). It is conformed to constant frame rate in the edit proxy so audio and video stay in sync.`,
      );
    }
    if (hdr) warnings.push('HDR source (PQ/HLG). The edit proxy is tone-mapped to BT.709 SDR; export tone-mapping applies the same transform.');
    else if (video.colorPrimaries === 'bt2020') warnings.push('Wide-gamut (BT.2020) source without HDR transfer; colours may look slightly desaturated in BT.709.');
    if (interlaced) warnings.push('Interlaced source; the edit proxy is deinterlaced.');
    if (rotation !== 0) warnings.push(`Rotation metadata (${rotation}°) is applied in the proxy.`);
  }

  let audio: AudioStreamInfo | undefined;
  if (audioStream) {
    audio = {
      codec: audioStream.codec_name ?? 'unknown',
      sampleRate: Number(audioStream.sample_rate) || 48_000,
      channels: audioStream.channels ?? 0,
      channelLayout: audioStream.channel_layout,
      startTime: parseDecimal(audioStream.start_time) ?? rational(0),
    };
  }

  // Duration: container duration; fall back to the longest stream.
  let duration = formatDuration;
  if (duration.num === 0) {
    for (const s of [videoStream, audioStream]) {
      const d = parseDecimal(s?.duration);
      if (d && d.num / d.den > duration.num / duration.den) duration = d;
    }
  }
  if (isImage) duration = rational(0);

  return {
    type,
    duration,
    fps,
    audioChannels: audio?.channels ?? 0,
    video,
    audio,
    container,
    warnings,
  };
}

/** Read every video packet's PTS (ticks) for CFR/VFR analysis. */
async function readPacketTimes(ffprobePath: string, file: string, streamIndex: number): Promise<number[]> {
  const r = await runText(ffprobePath, [
    '-v', 'error',
    '-select_streams', String(streamIndex),
    '-show_entries', 'packet=pts',
    '-of', 'csv=p=0',
    file,
  ]);
  if (r.code !== 0) return [];
  const out: number[] = [];
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (t && t !== 'N/A') {
      const n = Number(t.split(',')[0]);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

export async function probeFile(file: string, ffprobePath = 'ffprobe'): Promise<ProbedMedia> {
  const r = await runText(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr.trim().split('\n').pop() ?? 'unknown error'}`);
  let json: FfprobeJson;
  try {
    json = JSON.parse(r.stdout) as FfprobeJson;
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  const v = (json.streams ?? []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  let timing: FrameTimingReport | null = null;
  if (v && !IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    const tb = parseRational(v.time_base);
    if (tb) {
      const pts = await readPacketTimes(ffprobePath, file, v.index);
      if (pts.length >= 3) timing = analyzeFrameTiming(pts, tb);
    }
  }
  return interpretProbe(json, timing, file);
}

/** Frame count of the media's video at its nominal rate (for display / bounds). */
export function durationFrames(media: Pick<Media, 'duration' | 'fps'>): number {
  return media.fps ? secondsToTicks(media.duration, media.fps, 'round') : 0;
}
