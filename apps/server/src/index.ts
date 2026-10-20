import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';
import { startServer } from './start';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig({ webDist: path.resolve(here, '../../web/dist') });

const server = await startServer({ webDist: config.webDist });

console.log(`Cutroom server ${server.version} listening on ${server.url}`);
console.log(`  data dir : ${config.dataDir}`);
if (server.ffmpeg.ok) console.log(`  ffmpeg   : ${server.ffmpeg.version}`);
else console.warn(`  ffmpeg   : NOT READY — ${server.ffmpeg.problems.join(' ')} (the web app will show setup instructions)`);
if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
  console.warn('  WARNING  : listening on a non-loopback address; Host/Origin checks still restrict requests to localhost.');
}

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, saving project and shutting down…`);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
