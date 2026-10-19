/** `pnpm gen:sync-asset [out.mp4] [seconds] [fps]` — write the flash+beep A/V sync test asset. */
import path from 'node:path';
import { analyzeSync, generateSyncAsset } from '../test/helpers/media';

const out = path.resolve(process.argv[2] ?? 'sync-asset.mp4');
const seconds = Number(process.argv[3] ?? 10);
const fps = Number(process.argv[4] ?? 30);
await generateSyncAsset(out, { seconds, fps });
const r = await analyzeSync(out);
console.log(`wrote ${out}`);
console.log(`${r.flashTimes.length} flashes, ${r.beepTimes.length} beeps, max offset ${r.maxAbsOffsetMs.toFixed(2)} ms (${r.maxOffsetFrames} frames)`);
