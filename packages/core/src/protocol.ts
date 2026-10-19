import type { Patch } from 'immer';
import type { Sequence } from './edit/types';
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

export interface ProxySettingsResponse {
  codec: import('./media').ProxyCodec;
  /** Media whose proxies had to be regenerated for the new codec. */
  requeued: number;
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
  /** Files removed from the bin and skipped by scans. */
  ignoredCount: number;
}

export interface TransactionInfo {
  id: string;
  label: string;
  origin: string;
  revision: number;
  at: number;
  opCount: number;
}

export interface SnapshotInfo {
  id: string;
  label: string;
  origin: string;
  revision: number;
  at: number;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** Oldest first. */
  undo: TransactionInfo[];
  /** Next redo last. */
  redo: TransactionInfo[];
  /** Named snapshots, one per agent transaction (newest last). */
  snapshots: SnapshotInfo[];
}

export interface ProjectResponse {
  summary: ProjectSummary;
  project: Project;
  /** Sequence revision; patches are numbered from here. */
  revision: number;
  history: HistoryState;
}

export interface EditRequest {
  /** Human-readable summary: becomes the history entry. */
  label?: string;
  /** `user` or `agent:<name>`. */
  origin?: string;
  ops: unknown[];
  /** Reject if the server sequence has moved past this revision. */
  baseRevision?: number;
}

export interface EditResponse {
  revision: number;
  transaction: TransactionInfo | null;
  patches: Patch[];
  history: HistoryState;
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
  | { type: 'scan'; report: ScanReport }
  /** The sequence changed. `load` carries the whole sequence; the others carry Immer patches to apply in order. */
  | { type: 'sequence'; kind: 'commit' | 'undo' | 'redo' | 'load'; revision: number; patches: Patch[]; sequence?: Sequence }
  | { type: 'history'; history: HistoryState };

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
