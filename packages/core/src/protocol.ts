import type { Media, Project, ProjectSettings } from './media';

/** Types shared by the server and the web client (REST + WebSocket). */

export type JobKind = 'poster' | 'proxy' | 'analysis' | 'export';
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface JobInfo {
  id: string;
  kind: JobKind;
  label: string;
  mediaId?: string;
  state: JobState;
  /** 0..1 */
  progress: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface BinaryStatus {
  path: string;
  version: string;
  major: number;
  minor: number;
}

export interface FfmpegStatus {
  ok: boolean;
  ffmpeg: BinaryStatus | null;
  ffprobe: BinaryStatus | null;
  encoders: Record<string, boolean>;
  filters: Record<string, boolean>;
  /** Human-readable blockers; empty when ok. */
  problems: string[];
  /** Non-blocking notes (missing optional encoders/filters). */
  warnings: string[];
  platform: string;
  installHints: string[];
}

export interface HealthResponse {
  app: 'cutroom';
  version: string;
  ffmpeg: FfmpegStatus;
  dataDir: string;
  hasProject: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  folder: string;
  settings: ProjectSettings;
  mediaCount: number;
}

export interface ProjectResponse {
  summary: ProjectSummary;
  project: Project;
}

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  /** Number of importable media files directly inside `path`. */
  mediaFiles: number;
  quickLinks: { label: string; path: string }[];
}

export interface ScanReport {
  imported: number;
  changed: number;
  unchanged: number;
  missing: number;
  relinked: number;
  rejected: { path: string; reason: string }[];
}

export type ServerEvent =
  | { type: 'hello'; jobs: JobInfo[]; project: ProjectSummary | null }
  | { type: 'project'; project: ProjectSummary | null }
  | { type: 'job'; job: JobInfo }
  | { type: 'media'; media: Media }
  | { type: 'mediaRemoved'; mediaId: string }
  | { type: 'scan'; report: ScanReport };

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
