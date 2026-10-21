import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openVideoTrack } from '../src/playback/demux';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const haveFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0 && spawnSync(ffprobe, ['-version']).status === 0;

let dir: string;
let server: http.Server;
let base: string;
const ranges: string[] = [];

beforeAll(async () => {
  if (!haveFfmpeg) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-demux-'));
  // 20 s of 720p: big enough that reading it whole would be obvious; once with the header in front, once at the end
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-movflags', '+faststart', path.join(dir, 'front.mp4')]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', path.join(dir, 'front.mp4'), '-c', 'copy', path.join(dir, 'end.mp4')]);
  server = http.createServer((req, res) => {
    const file = path.join(dir, path.basename(req.url ?? ''));
    const size = fs.statSync(file).size;
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    const a = m ? Number(m[1]) : 0;
    const b = m ? Math.min(Number(m[2]), size - 1) : size - 1;
    ranges.push(`${path.basename(file)} ${a}-${b}`);
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1 });
    fs.createReadStream(file, { start: a, end: b }).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (!haveFfmpeg) return;
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** What ffprobe says each video packet is: byte position and size, decode order. */
const packets = (file: string) =>
  execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pos,size,flags', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => {
      const [size, pos, flags] = l.split(',');
      return { offset: Number(pos), size: Number(size), sync: (flags ?? '').includes('K') };
    });

describe.skipIf(!haveFfmpeg)('openVideoTrack', () => {
  for (const name of ['front.mp4', 'end.mp4']) {
    it(`reads only the header of ${name} and gets every sample where ffprobe sees it`, async () => {
      ranges.length = 0;
      const info = await openVideoTrack(`${base}/${name}`);
      const size = fs.statSync(path.join(dir, name)).size;
      const read = ranges.reduce((n, r) => n + (Number(r.split(/[ -]/)[2]) - Number(r.split(/[ -]/)[1]) + 1), 0);
      expect(read).toBeLessThan(size / 20); // a handful of small reads, not the media
      expect(ranges.length).toBeLessThan(10);
      const want = packets(path.join(dir, name));
      expect(info.samples.length).toBe(want.length);
      expect(info.samples.map((s) => ({ offset: s.offset, size: s.size, sync: s.sync }))).toEqual(want);
      expect([info.width, info.height]).toEqual([1280, 720]);
    });
  }
});
