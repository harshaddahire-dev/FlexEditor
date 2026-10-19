import type { Rational } from './time';

export type MediaType = 'video' | 'audio' | 'image';

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
export type AnalysisState = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface MediaStatus {
  probe: AnalysisState;
  poster: AnalysisState;
  proxy: AnalysisState;
  /** Filled in by the media-intelligence step. */
  waveform: AnalysisState;
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
  /** Geometry/rate of the generated proxy (constant frame rate, square pixels). */
  proxy?: { width: number; height: number; fps: Rational };
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
  sequences: unknown[];
  captionStyles: unknown[];
  history: unknown[];
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
    transcript: 'pending',
    silences: 'pending',
    scenes: 'pending',
    beats: 'pending',
    loudness: 'pending',
  };
}
