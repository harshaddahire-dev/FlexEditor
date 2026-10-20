export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'uptodate' | 'error';

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  latest: string | null;
  percent: number;
  notes: string | null;
  error: string | null;
  lastChecked: number | null;
  auto: boolean;
  /** false where the app cannot replace itself (macOS builds are unsigned): "download" opens the release page instead */
  canInstall: boolean;
  releaseUrl: string;
  bytesPerSecond: number;
}

/** What the desktop app (Electron) adds to the page; absent in a normal browser. */
export interface DesktopBridge {
  platform: string;
  /** Native folder dialog; null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Reveal a file or folder in Explorer / Finder. */
  reveal(path: string): Promise<void>;
  /** Copies facts about graphics, codecs, media and the timeline for a bug report. */
  copyDiagnostics(): Promise<void>;
  updates: {
    get(): Promise<UpdateState | null>;
    check(): Promise<UpdateState | null>;
    download(): Promise<void>;
    /** `{ok:false, reason:'busy'}` when a render or agent run is in progress and force is not set. */
    install(force?: boolean): Promise<{ ok: boolean; reason?: string }>;
    setAuto(on: boolean): Promise<void>;
    onState(cb: (s: UpdateState) => void): () => void;
  };
}

export const desktop = (): DesktopBridge | null => (window as unknown as { cutroomDesktop?: DesktopBridge }).cutroomDesktop ?? null;
