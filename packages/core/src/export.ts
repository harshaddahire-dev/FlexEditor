/** Export presets and the request/response types shared by the browser and the server. */

export type VideoCodec = 'h264' | 'vp9' | 'prores';
export type AudioCodec = 'aac' | 'opus' | 'pcm24';
export type Container = 'mp4' | 'webm' | 'mov' | 'wav';

export interface ExportPreset {
  id: string;
  label: string;
  description: string;
  container: Container;
  video: VideoCodec | null;
  audio: AudioCodec;
  /** Extension of the file written. */
  ext: string;
  /** Nominal video bitrate (bits/s) for browser encoders, scaled by pixel count; ignored by ProRes/PCM. */
  bitrate1080: number;
  /** The browser's VideoEncoder can make this video codec; ProRes always goes through FFmpeg. */
  webcodecs: boolean;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'h264-mp4', label: 'H.264 · MP4', description: 'Plays everywhere: YouTube, social, phones.', container: 'mp4', video: 'h264', audio: 'aac', ext: 'mp4', bitrate1080: 12_000_000, webcodecs: true },
  { id: 'vp9-webm', label: 'VP9 · WebM', description: 'Open format for the web.', container: 'webm', video: 'vp9', audio: 'opus', ext: 'webm', bitrate1080: 8_000_000, webcodecs: true },
  { id: 'prores-mov', label: 'ProRes 422 HQ · MOV', description: 'Editing / mastering format. Rendered with FFmpeg.', container: 'mov', video: 'prores', audio: 'pcm24', ext: 'mov', bitrate1080: 0, webcodecs: false },
  { id: 'audio-wav', label: 'Audio only · WAV', description: '24-bit PCM mix-down of the program audio.', container: 'wav', video: null, audio: 'pcm24', ext: 'wav', bitrate1080: 0, webcodecs: false },
];

export const exportPreset = (id: string): ExportPreset | undefined => EXPORT_PRESETS.find((p) => p.id === id);

/** `webcodecs`: frames are rendered by the monitor's compositor and encoded in the browser. `ffmpeg`: FFmpeg renders them from the originals. */
export type ExportEngine = 'webcodecs' | 'ffmpeg';

export type CaptionExport = 'burn' | 'sidecar' | 'both' | 'none';

export interface ExportRequest {
  preset: string;
  /** File name without extension. */
  name: string;
  engine: ExportEngine;
  /** Timeline range in ticks, [from, to). Defaults to the whole sequence. */
  from?: number;
  to?: number;
  captions: CaptionExport;
  /** Output size; defaults to the sequence's. Even numbers only. */
  width?: number;
  height?: number;
  /** Render from proxies (fast draft) instead of the originals. WebCodecs engine only. */
  draft?: boolean;
}

export type ExportPhase = 'waiting' | 'audio' | 'video' | 'mux' | 'done';

export interface ExportInfo {
  id: string;
  jobId: string;
  request: ExportRequest;
  phase: ExportPhase;
  /** Absolute path of the finished file, once done. */
  output?: string;
  sidecars: string[];
  /** What was made, measured from the file itself. */
  result?: { durationSeconds: number; sizeBytes: number; frames?: number; width?: number; height?: number; videoCodec?: string; audioCodec?: string };
  /** Honest notes: effects approximated by the FFmpeg engine, proxies used, etc. */
  warnings: string[];
}

/** Whole-sequence range, rounded to whole frames. */
export function exportRange(durationTicks: number, req: Pick<ExportRequest, 'from' | 'to'>): { from: number; to: number } {
  const from = Math.max(0, Math.min(req.from ?? 0, durationTicks));
  const to = Math.max(from, Math.min(req.to ?? durationTicks, durationTicks));
  return { from, to };
}

/** A safe file name stem: no separators, no leading dots, bounded length. */
export function safeFileStem(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return s || 'export';
}
