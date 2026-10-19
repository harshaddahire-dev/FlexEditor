import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, APP_VERSION } from './app';
import { loadConfig } from './config';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig({ webDist: path.resolve(here, '../../web/dist') });

const { app } = await buildApp(config, { logger: false });
const health = (await app.inject('/api/health')).json() as { ffmpeg: { ok: boolean; problems: string[]; ffmpeg: { version: string } | null } };

await app.listen({ host: config.host, port: config.port });

console.log(`Cutroom server ${APP_VERSION} listening on http://${config.host}:${config.port}`);
console.log(`  data dir : ${config.dataDir}`);
if (health.ffmpeg.ok) console.log(`  ffmpeg   : ${health.ffmpeg.ffmpeg?.version}`);
else console.warn(`  ffmpeg   : NOT READY — ${health.ffmpeg.problems.join(' ')} (the web app will show setup instructions)`);
if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
  console.warn('  WARNING  : listening on a non-loopback address; Host/Origin checks still restrict requests to localhost.');
}

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, saving project and shutting down…`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
