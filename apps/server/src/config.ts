import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  /** Directory holding the built web app (production mode). */
  webDist: string | null;
}

/** Per-user app data directory (settings, recent projects). */
export function defaultDataDir(): string {
  if (process.env.CUTROOM_DATA_DIR) return process.env.CUTROOM_DATA_DIR;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Cutroom');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cutroom');
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'cutroom');
  }
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: process.env.CUTROOM_HOST ?? '127.0.0.1',
    port: Number(process.env.CUTROOM_PORT ?? 3001),
    dataDir: defaultDataDir(),
    ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
    webDist: null,
    ...overrides,
  };
}
