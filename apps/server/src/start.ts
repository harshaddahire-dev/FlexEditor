import type { AddressInfo } from 'node:net';
import { type BuiltApp, APP_VERSION, buildApp } from './app';
import { type ServerConfig, loadConfig } from './config';

export interface RunningServer {
  url: string;
  port: number;
  built: BuiltApp;
  /** FFmpeg status as the app will show it (ok + what is missing). */
  ffmpeg: { ok: boolean; problems: string[]; version: string | null };
  version: string;
  /** Saves the project and stops everything. */
  close(): Promise<void>;
}

/**
 * Start the server in this process. `index.ts` (`pnpm dev` / `pnpm start`) and the desktop app both use it; the desktop
 * app passes port 0 (any free port), its own data folder, the bundled FFmpeg and the bundled web app.
 */
export async function startServer(overrides: Partial<ServerConfig> = {}, opts: { logger?: boolean } = {}): Promise<RunningServer> {
  const config = loadConfig(overrides);
  const built = await buildApp(config, { logger: opts.logger ?? false });
  const health = (await built.app.inject('/api/health')).json() as { ffmpeg: { ok: boolean; problems: string[]; ffmpeg: { version: string } | null } };
  await built.app.listen({ host: config.host, port: config.port });
  const port = (built.app.server.address() as AddressInfo).port;
  return {
    url: `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`,
    port,
    built,
    ffmpeg: { ok: health.ffmpeg.ok, problems: health.ffmpeg.problems, version: health.ffmpeg.ffmpeg?.version ?? null },
    version: APP_VERSION,
    close: () => built.app.close(),
  };
}
