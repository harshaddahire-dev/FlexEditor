import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBinary, runText } from '../../src/proc';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

export const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.fixtures');

async function ff(args: string[]): Promise<void> {
  const r = await runText(FFMPEG, ['-y', '-hide_banner', '-nostdin', '-v', 'error', ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr}`);
}

export interface SyncAssetOptions {
  seconds?: number;
  /** Integer frame rate so that "once per second" lands on an exact frame. */
  fps?: number;
  width?: number;
  height?: number;
  /** Drop frames 3 and 4 of every 10 (except the flash frames) to make a variable-frame-rate file. */
  vfr?: boolean;
  /** Extra output video filters, e.g. `setsar=4/3`. */
  vf?: string;
  /** Delay the audio stream by this many seconds (its container start_time becomes > 0). */
  audioDelay?: number;
  /** Delay the video stream (its start_time becomes > 0). */
  videoDelay?: number;
}

/**
 * The canonical A/V sync asset: a single white frame and a 50 ms 1 kHz beep start together at every whole
 * second (frame index k*fps ⇔ sample k*48000); everything else is black / silent.
 */
export async function generateSyncAsset(out: string, o: SyncAssetOptions = {}): Promise<string> {
  const { seconds = 6, fps = 30, width = 640, height = 360 } = o;
  await fs.mkdir(path.dirname(out), { recursive: true });
  const filters: string[] = [];
  if (o.vfr) filters.push('select=lt(mod(n\\,10)\\,3)+gt(mod(n\\,10)\\,4)');
  if (o.vf) filters.push(o.vf);
  await ff([
    ...(o.videoDelay ? ['-itsoffset', String(o.videoDelay)] : []),
    '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${seconds},drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(n,${fps}),1)',format=yuv420p`,
    ...(o.audioDelay ? ['-itsoffset', String(o.audioDelay)] : []),
    '-f', 'lavfi', '-i', `aevalsrc='if(lt(mod(t,1),0.05),0.6*sin(2*PI*1000*t),0)':s=48000:d=${seconds}`,
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-fps_mode', o.vfr ? 'vfr' : o.videoDelay ? 'passthrough' : 'cfr', // cfr would duplicate frames to fill a leading gap
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', String(fps),
    '-c:a', 'aac', '-b:a', '128k',
    out,
  ]);
  return out;
}

export interface SyncReport {
  fps: number;
  flashTimes: number[];
  beepTimes: number[];
  /** beep − flash, per second, in milliseconds */
  offsetsMs: number[];
  maxAbsOffsetMs: number;
  /** Largest offset expressed in whole frames (0 ⇒ perfectly in sync at frame resolution). */
  maxOffsetFrames: number;
  /** Time of every decoded video frame, for CFR checks. */
  frameTimes: number[];
}

/** Decode a file (or a video proxy + its audio proxy) and measure where each flash and each beep actually lands. */
export async function analyzeSync(file: string, audioFile: string = file): Promise<SyncReport> {
  // video: tiny gray frames in presentation order + their timestamps
  const frames = await runBinary(FFMPEG, [
    '-v', 'error', '-i', file, '-map', '0:v:0', '-vf', 'scale=4:4:flags=area,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1',
  ]);
  const times = await runText(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file]);
  const frameTimes = times.stdout.split('\n').map((l) => l.trim().split(',')[0]!).filter(Boolean).map(Number);
  const n = frames.stdout.length / 16;
  if (n !== frameTimes.length) throw new Error(`frame count mismatch: ${n} decoded vs ${frameTimes.length} timestamps`);

  const flashTimes: number[] = [];
  let inFlash = false;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += frames.stdout[i * 16 + j]!;
    const bright = sum / 16 > 180;
    if (bright && !inFlash) flashTimes.push(frameTimes[i]!);
    inFlash = bright;
  }

  const fpsProbe = await runText(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', file]);
  const [fn, fd] = fpsProbe.stdout.trim().split('/').map(Number);
  const fps = fn! / (fd || 1);

  // audio: mono 48 kHz PCM laid out on the media timeline (leading gap padded, so index 0 == t 0)
  const pcm = await runBinary(FFMPEG, [
    '-v', 'error', '-i', audioFile, '-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1',
  ]);
  const samples = new Int16Array(pcm.stdout.buffer, pcm.stdout.byteOffset, Math.floor(pcm.stdout.length / 2));
  const beepTimes: number[] = [];
  let lastOnset = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) > 8000 && i - lastOnset > 24_000) {
      beepTimes.push(i / 48_000);
      lastOnset = i;
    }
  }

  const pairs = Math.min(flashTimes.length, beepTimes.length);
  const offsetsMs = Array.from({ length: pairs }, (_, k) => (beepTimes[k]! - flashTimes[k]!) * 1000);
  const maxAbsOffsetMs = offsetsMs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return {
    fps,
    flashTimes,
    beepTimes,
    offsetsMs,
    maxAbsOffsetMs,
    maxOffsetFrames: Math.round((maxAbsOffsetMs / 1000) * fps),
    frameTimes,
  };
}

export interface Fixtures {
  dir: string;
  sync: string;
  vfr: string;
  rotated: string;
  anamorphic: string;
  hdr: string;
  tone: string;
  still: string;
}

let cached: Promise<Fixtures> | null = null;

/** Generate (once, cached on disk) the small media files the integration tests share. */
export function fixtures(): Promise<Fixtures> {
  cached ??= (async () => {
    const dir = FIXTURE_DIR;
    const f: Fixtures = {
      dir,
      sync: path.join(dir, 'sync.mp4'),
      vfr: path.join(dir, 'sync-vfr.mp4'),
      rotated: path.join(dir, 'sync-rot90.mp4'),
      anamorphic: path.join(dir, 'sync-anamorphic.mp4'),
      hdr: path.join(dir, 'hdr.mp4'),
      tone: path.join(dir, 'tone.wav'),
      still: path.join(dir, 'still.png'),
    };
    const missing = async (p: string) => !(await fs.stat(p).then(() => true, () => false));
    await fs.mkdir(dir, { recursive: true });
    if (await missing(f.sync)) await generateSyncAsset(f.sync);
    if (await missing(f.vfr)) await generateSyncAsset(f.vfr, { vfr: true });
    if (await missing(f.rotated)) {
      const src = path.join(dir, 'rot-src.mp4');
      await generateSyncAsset(src, { seconds: 3 });
      await ff(['-display_rotation', '90', '-i', src, '-c', 'copy', f.rotated]);
      await fs.rm(src);
    }
    if (await missing(f.anamorphic)) await generateSyncAsset(f.anamorphic, { seconds: 3, width: 480, height: 360, vf: 'setsar=4/3' });
    if (await missing(f.hdr)) {
      await ff([
        '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2,format=yuv420p10le',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
        '-x265-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:log-level=error',
        f.hdr,
      ]);
    }
    if (await missing(f.tone)) await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', '-ac', '2', f.tone]);
    if (await missing(f.still)) await ff(['-f', 'lavfi', '-i', 'testsrc2=s=400x300', '-frames:v', '1', f.still]);
    return f;
  })();
  return cached;
}
