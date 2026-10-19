import type { Sequence } from './edit/types';
import type { Rational } from './time';

export type MediaType = 'video' | 'audio' | 'image';

/** Video codec of edit proxies. H.264 where the browser can decode it, VP9 otherwise (open-source Chromium, some Linux builds). */
export type ProxyCodec = 'h264' | 'vp9';

export type ColorRange = 'limited' | 'full' | 'unknown';

export interface VideoStreamInfo {
  codec: string;
  profile?: string;
  pixFmt?: string;
  bitDepth: number;
  /** Coded size, before rotation / pixel-aspect correction. */
  codedWidth: number;
  codedHeight: number;
  /** Size as displayed: rotation applied, pixel aspect ratio folded into width. */
  width: number;
  height: number;
  /** Clockwise display rotation in degrees (0, 90, 180, 270). */
  rotation: 0 | 90 | 180 | 270;
  /** Sample (pixel) aspect ratio; 1/1 for square pixels. */
  sar: Rational;
  /** Nominal frame rate used for editing (CFR value, or snapped average for VFR). */
  fps: Rational;
  /** ffprobe avg_frame_rate, for diagnostics. */
  avgFps: Rational | null;
  /** Number of video frames in the stream, if known. */
  frameCount: number | null;
  /** True when frame timestamps are not constant. */
  vfr: boolean;
  interlaced: boolean;
  colorRange: ColorRange;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  hdr: boolean;
  /** Seconds the video stream starts after the container origin. */
  startTime: Rational;
}

export interface AudioStreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  channelLayout?: string;
  startTime: Rational;
}

/** pending: nothing scheduled · queued: job waiting · running: job active */
/** unavailable: a required tool (e.g. whisper.cpp) is not installed — distinct from failed, and retried when it appears. */
export type AnalysisState = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'unavailable';

export interface MediaStatus {
  probe: AnalysisState;
  poster: AnalysisState;
  proxy: AnalysisState;
  waveform: AnalysisState;
  /** Timeline filmstrip (thumbnail sprite). */
  filmstrip: AnalysisState;
  transcript: AnalysisState;
  silences: AnalysisState;
  scenes: AnalysisState;
  beats: AnalysisState;
  loudness: AnalysisState;
}

export interface Media {
  id: string;
  /** Relative to the project folder (POSIX separators) when inside it, otherwise absolute. */
  path: string;
  /** Relative to the project folder; undefined until the proxy exists. */
  proxyPath?: string;
  /** Geometry/rate/codec of the generated video proxy (constant frame rate, square pixels). */
  proxy?: { width: number; height: number; fps: Rational; codec: ProxyCodec };
  /** 48 kHz PCM WAV of the audio, on the same time origin as the video proxy. */
  audioProxyPath?: string;
  posterPath?: string;
  type: MediaType;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  /** Exact duration in seconds. Zero for still images. */
  duration: Rational;
  /** Frame rate for video; undefined for audio/image. */
  fps?: Rational;
  audioChannels: number;
  video?: VideoStreamInfo;
  audio?: AudioStreamInfo;
  container?: string;
  status: MediaStatus;
  missing: boolean;
  warnings: string[];
  /** Populated by media intelligence (step 4). */
  analysis: Record<string, unknown>;
  importedAt: string;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: Rational;
  sampleRate: number;
  /** True until the first video import fixes width/height/fps from the footage. */
  auto?: boolean;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  settings: ProjectSettings;
  media: Media[];
  sequences: Sequence[];
  captionStyles: unknown[];
  history: unknown[];
  /** Files the user removed from the bin; rescans skip them until they are explicitly re-included. */
  ignoredPaths?: string[];
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: { num: 30000, den: 1001 },
  sampleRate: 48_000,
  auto: true,
};

export function emptyStatus(): MediaStatus {
  return {
    probe: 'pending',
    poster: 'pending',
    proxy: 'pending',
    waveform: 'pending',
    filmstrip: 'pending',
    transcript: 'pending',
    silences: 'pending',
    scenes: 'pending',
    beats: 'pending',
    loudness: 'pending',
  };
}

export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.ts', '.mxf', '.mpg', '.mpeg', '.wmv', '.flv', '.3gp',
]);
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.aif', '.aiff', '.wma',
]);
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif']);

/** Lower-cased extension including the dot ('' when none). Works on both POSIX and Windows paths. */
export function extensionOf(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

export function isSupportedExtension(file: string): boolean {
  const ext = extensionOf(file);
  return VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}
