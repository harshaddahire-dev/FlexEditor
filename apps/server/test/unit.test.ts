import { describe, expect, it } from 'vitest';
import { isSupportedExtension, rational } from '@cutroom/core';
import { analyzeFrameTiming } from '../src/timing';
import { displaySize, interpretProbe, type FfprobeJson } from '../src/probe';
import { planProxy, proxyDimensions, buildProxyArgs, buildAudioProxyArgs, planAudioProxy } from '../src/proxy';
import { parseVersion } from '../src/ffmpeg';
import { isAllowedRequest, resolveInside, sanitizeRelativeUploadPath, UnsafePathError } from '../src/security';
import { parseRange } from '../src/files';
import { toStoredPath, fromStoredPath } from '../src/paths';
import { JobQueue } from '../src/jobs';
import { mapLimit } from '../src/util';

describe('analyzeFrameTiming', () => {
  const tb90k = rational(1, 90000);
  it('CFR 29.97 with B-frame (decode-order) PTS is constant', () => {
    // decode order I P B B … the PTS are shuffled but the set is evenly spaced
    const pts = [0, 12012, 6006, 3003, 9009, 24024, 18018, 15015, 21021];
    const r = analyzeFrameTiming(pts, tb90k);
    expect(r.vfr).toBe(false);
    expect(r.medianDelta).toBe(3003);
    expect(r.avgFps).toBeCloseTo(29.97, 2);
  });
  it('millisecond-timebase rounding jitter (33/33/34) is still CFR', () => {
    const pts: number[] = [];
    for (let i = 0; i < 300; i++) pts.push(Math.round((i * 1001) / 30)); // 33.37 ms → 33/34 ms
    expect(analyzeFrameTiming(pts, rational(1, 1000)).vfr).toBe(false);
  });
  it('dropped frames make it VFR', () => {
    const pts = [0, 1, 2, 5, 6, 7, 8, 11, 12, 13].map((n) => n * 3000);
    const r = analyzeFrameTiming(pts, tb90k);
    expect(r.vfr).toBe(true);
    expect(r.irregular).toBe(2);
  });
  it('phone-style jitter (±30 %) is VFR', () => {
    const pts: number[] = [0];
    for (let i = 1; i < 100; i++) pts.push(pts[i - 1]! + (i % 7 === 0 ? 4400 : 3003));
    expect(analyzeFrameTiming(pts, tb90k).vfr).toBe(true);
  });
  it('tiny streams are not classified', () => {
    expect(analyzeFrameTiming([0, 3003], tb90k).vfr).toBe(false);
  });
});

describe('probe interpretation', () => {
  const base: FfprobeJson = {
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.010000' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001', time_base: '1/30000', pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1', color_range: 'tv', color_space: 'bt709', start_time: '0.000000' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo', start_time: '0.000000' },
    ],
  };

  it('reads a plain CFR video', () => {
    const m = interpretProbe(base, null, 'a.mp4');
    expect(m.type).toBe('video');
    expect(m.fps).toEqual(rational(30000, 1001));
    expect(m.duration).toEqual({ num: 1001, den: 100 });
    expect(m.video).toMatchObject({ width: 1920, height: 1080, rotation: 0, vfr: false, hdr: false, colorRange: 'limited' });
    expect(m.audio).toMatchObject({ sampleRate: 48000, channels: 2 });
    expect(m.warnings).toEqual([]);
  });

  it('applies display-matrix rotation (ffprobe reports counter-clockwise degrees)', () => {
    const j = structuredClone(base);
    j.streams![0]!.side_data_list = [{ side_data_type: 'Display Matrix', rotation: -90 }];
    const m = interpretProbe(j, null, 'a.mov');
    expect(m.video).toMatchObject({ rotation: 90, width: 1080, height: 1920, codedWidth: 1920, codedHeight: 1080 });
    expect(m.warnings.join()).toMatch(/Rotation/);
    j.streams![0]!.side_data_list = [{ side_data_type: 'Display Matrix', rotation: 90 }];
    expect(interpretProbe(j, null, 'a.mov').video?.rotation).toBe(270);
  });

  it('folds pixel aspect ratio into display width', () => {
    expect(displaySize(1440, 1080, rational(4, 3), 0)).toEqual({ width: 1920, height: 1080 });
    expect(displaySize(720, 480, rational(8, 9), 0)).toEqual({ width: 720, height: 540 });
    expect(displaySize(1440, 1080, rational(4, 3), 90)).toEqual({ width: 1080, height: 1920 });
  });

  it('flags VFR using packet timing and snaps the rate', () => {
    const j = structuredClone(base);
    j.streams![0]!.r_frame_rate = '30/1';
    j.streams![0]!.avg_frame_rate = '2997/100';
    const timing = { count: 100, vfr: true, medianDelta: 3003, minDelta: 3003, maxDelta: 9009, irregular: 4, avgFps: 29.9 };
    const m = interpretProbe(j, timing, 'phone.mp4');
    expect(m.video?.vfr).toBe(true);
    expect(m.fps).toEqual(rational(30000, 1001));
    expect(m.warnings[0]).toMatch(/Variable frame rate/);
  });

  it('falls back to r_frame_rate vs avg_frame_rate when there is no packet data', () => {
    const j = structuredClone(base);
    j.streams![0]!.r_frame_rate = '60/1';
    j.streams![0]!.avg_frame_rate = '4000/133';
    expect(interpretProbe(j, null, 'x.mp4').video?.vfr).toBe(true);
  });

  it('ignores container-artefact frame rates such as 1000/1', () => {
    const j = structuredClone(base);
    j.streams![0]!.r_frame_rate = '1000/1';
    j.streams![0]!.avg_frame_rate = '30/1';
    expect(interpretProbe(j, null, 'x.mkv').fps).toEqual(rational(30));
  });

  it('detects HDR and full-range', () => {
    const j = structuredClone(base);
    Object.assign(j.streams![0]!, { color_transfer: 'smpte2084', color_primaries: 'bt2020', color_range: 'pc', pix_fmt: 'yuv420p10le' });
    const m = interpretProbe(j, null, 'x.mp4');
    expect(m.video).toMatchObject({ hdr: true, colorRange: 'full', bitDepth: 10 });
    expect(m.warnings.join()).toMatch(/HDR/);
    j.streams![0]!.color_transfer = 'arib-std-b67';
    expect(interpretProbe(j, null, 'x.mp4').video?.hdr).toBe(true);
  });

  it('classifies audio-only (ignoring cover art) and stills', () => {
    const audio = interpretProbe(
      { format: { format_name: 'mp3', duration: '3.0' }, streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }, { index: 1, codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } }] },
      null,
      'song.mp3',
    );
    expect(audio.type).toBe('audio');
    expect(audio.video).toBeUndefined();
    const still = interpretProbe({ format: { format_name: 'png_pipe' }, streams: [{ index: 0, codec_type: 'video', codec_name: 'png', width: 400, height: 300, r_frame_rate: '25/1', avg_frame_rate: '25/1' }] }, null, 'a.png');
    expect(still.type).toBe('image');
    expect(still.duration).toEqual({ num: 0, den: 1 });
    expect(still.fps).toBeUndefined();
  });

  it('throws when there is nothing to edit', () => {
    expect(() => interpretProbe({ format: {}, streams: [] }, null, 'x.mp4')).toThrow();
  });

  it('knows supported extensions', () => {
    expect(isSupportedExtension('A.MOV')).toBe(true);
    expect(isSupportedExtension('notes.txt')).toBe(false);
  });
});

describe('proxy planning', () => {
  it('caps the short side at 1080 and keeps even dimensions', () => {
    expect(proxyDimensions(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(proxyDimensions(2160, 3840)).toEqual({ width: 1080, height: 1920 });
    expect(proxyDimensions(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(proxyDimensions(3440, 1440)).toEqual({ width: 2580, height: 1080 });
    expect(proxyDimensions(853, 479)).toEqual({ width: 854, height: 480 });
  });

  const video = {
    codec: 'h264', bitDepth: 8, codedWidth: 3840, codedHeight: 2160, width: 3840, height: 2160, rotation: 0 as const,
    sar: rational(1), fps: rational(30000, 1001), avgFps: null, frameCount: null, vfr: false, interlaced: false,
    colorRange: 'limited' as const, colorSpace: 'bt709', hdr: false, startTime: rational(0),
  };

  it('conforms to CFR, square pixels, BT.709 limited', () => {
    const plan = planProxy(video, { filters: {} });
    expect(plan).toMatchObject({ codec: 'h264', width: 1920, height: 1080, gop: 15 });
    expect(plan.filter).toContain('fps=30000/1001');
    expect(plan.filter).toContain('scale=1920:1080');
    expect(plan.filter).toContain('out_color_matrix=bt709:out_range=tv');
    expect(plan.filter).toContain('setsar=1');
    expect(plan.filter.endsWith('format=yuv420p')).toBe(true);
    expect(plan.filter).not.toContain('in_color_matrix'); // tagged source: trust the tags
  });

  it('assumes BT.709 for untagged HD and BT.601 for untagged SD', () => {
    expect(planProxy({ ...video, colorSpace: undefined }, { filters: {} }).filter).toContain('in_color_matrix=bt709');
    expect(planProxy({ ...video, colorSpace: undefined, height: 480, width: 640 }, { filters: {} }).filter).toContain('in_color_matrix=bt601');
  });

  it('tone-maps HDR when zscale exists, warns when it does not', () => {
    const hdr = { ...video, hdr: true };
    const ok = planProxy(hdr, { filters: { zscale: true, tonemap: true } });
    expect(ok.filter).toContain('tonemap=tonemap=hable');
    expect(ok.warnings).toEqual([]);
    const no = planProxy(hdr, { filters: {} });
    expect(no.filter).not.toContain('tonemap');
    expect(no.warnings[0]).toMatch(/tone-mapped/);
  });

  it('deinterlaces', () => {
    expect(planProxy({ ...video, interlaced: true }, { filters: {} }).filter.startsWith('yadif')).toBe(true);
  });

  it('video proxies carry no audio (it lives in a separate WAV); H.264 has short GOP, no B-frames, fast-start', () => {
    const args = buildProxyArgs('in.mov', 'out.mp4', planProxy(video, { filters: {} }));
    expect(args).toEqual(expect.arrayContaining(['-an', '-c:v', 'libx264', '-g', '15', '-bf', '0', '-movflags', '+faststart']));
    expect(args).not.toContain('-c:a');
  });

  it('VP9 proxies are real-time, look-ahead free (presentation order) and tagged vp09', () => {
    const args = buildProxyArgs('in.mov', 'out.mp4', planProxy(video, { filters: {} }, 'vp9'));
    expect(args).toEqual(expect.arrayContaining(['libvpx-vp9', '-deadline', 'realtime', '-lag-in-frames', '0', '-auto-alt-ref', '0', '-g', '15', 'vp09']));
    expect(args).not.toContain('libx264');
  });
});

describe('audio proxy', () => {
  const audio = { codec: 'aac', sampleRate: 44100, channels: 6, startTime: rational(0) };
  const vid = { startTime: rational(0) } as never;

  it('is 48 kHz PCM, stereo at most', () => {
    const args = buildAudioProxyArgs('in.mov', 'out.wav', planAudioProxy(audio, vid));
    expect(args).toEqual(expect.arrayContaining(['-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-f', 'wav']));
    expect(planAudioProxy({ ...audio, channels: 1 }, vid).channels).toBe(1);
  });

  it('keeps the container time origin: audio that starts after it is padded with silence', () => {
    const late = planAudioProxy({ ...audio, startTime: rational(21, 1000) }, vid);
    expect(late.offsetSec).toBeCloseTo(0.021, 6);
    expect(buildAudioProxyArgs('a', 'b', late).join(' ')).toContain('adelay=21:all=1');
    expect(buildAudioProxyArgs('a', 'b', planAudioProxy(audio, vid)).join(' ')).not.toContain('adelay');
    // video starting later than the audio: the origin is the audio's start, so no padding is needed
    expect(planAudioProxy(audio, { startTime: rational(1, 10) } as never).offsetSec).toBe(0);
    // both start late together: the origin moves with them
    expect(planAudioProxy({ ...audio, startTime: rational(1, 10) }, { startTime: rational(1, 10) } as never).offsetSec).toBe(0);
  });

  it('audio-only media uses its own start as the origin', () => {
    expect(planAudioProxy({ ...audio, startTime: rational(5, 100) }, undefined).offsetSec).toBe(0);
  });
});

describe('ffmpeg version parsing', () => {
  it.each([
    ['ffmpeg version 6.1.1-3ubuntu5 Copyright', 6, 1],
    ['ffmpeg version n7.0 Copyright', 7, 0],
    ['ffprobe version 5.1.2 Copyright', 5, 1],
    ['ffmpeg version N-117000-gabc123 Copyright', 99, 0],
  ])('%s', (banner, major, minor) => {
    expect(parseVersion(banner)).toMatchObject({ major, minor });
  });
  it('rejects garbage', () => expect(parseVersion('hello')).toBeNull());
});

describe('request guard', () => {
  it('allows loopback hosts and origins', () => {
    expect(isAllowedRequest({ host: 'localhost:5173', origin: 'http://localhost:5173' })).toBe(true);
    expect(isAllowedRequest({ host: '127.0.0.1:3001' })).toBe(true);
    expect(isAllowedRequest({ host: '[::1]:3001', origin: 'http://[::1]:5173' })).toBe(true);
  });
  it('blocks DNS-rebinding hosts and foreign origins', () => {
    expect(isAllowedRequest({ host: 'evil.example.com' })).toBe(false);
    expect(isAllowedRequest({ host: 'localhost:3001', origin: 'https://evil.example.com' })).toBe(false);
    expect(isAllowedRequest({ host: 'localhost:3001', origin: 'null' })).toBe(false);
    expect(isAllowedRequest({ host: 'localhost.evil.com' })).toBe(false);
    expect(isAllowedRequest({})).toBe(false);
  });
});

describe('upload path sanitising', () => {
  it('accepts nested relative media paths', () => {
    expect(sanitizeRelativeUploadPath('clips/take 1.mp4')).toBe('clips/take 1.mp4');
    expect(sanitizeRelativeUploadPath('a\\b\\c.wav')).toBe('a/b/c.wav');
  });
  it.each(['../x.mp4', '/etc/passwd.mp4', 'C:\\x.mp4', 'a/../../b.mp4', '.hidden/a.mp4', 'a/.cutroom/x.mp4', 'a.txt', 'dir/', '', 'a/b:c.mp4'])('rejects %j', (p) => {
    expect(() => sanitizeRelativeUploadPath(p)).toThrow(UnsafePathError);
  });
  it('resolveInside refuses escapes', () => {
    expect(resolveInside('/proj', 'a/b.mp4')).toMatch(/proj.a.b\.mp4$/);
    expect(() => resolveInside('/proj', '../etc')).toThrow(UnsafePathError);
  });
});

describe('stored paths & ranges', () => {
  it('stores POSIX-relative paths inside the project and absolute ones outside', () => {
    expect(toStoredPath('/p', '/p/a/b.mp4')).toBe('a/b.mp4');
    expect(toStoredPath('/p', '/q/b.mp4')).toBe('/q/b.mp4');
    expect(fromStoredPath('/p', 'a/b.mp4')).toMatch(/p.a.b\.mp4$/);
    expect(fromStoredPath('/p', '/q/b.mp4')).toBe('/q/b.mp4');
  });
  it('parses byte ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-999', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-2', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });
});

describe('JobQueue', () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('respects the concurrency limit and reports lifecycle events', async () => {
    const q = new JobQueue(2);
    let active = 0;
    let peak = 0;
    const states: string[] = [];
    q.on('update', (j) => states.push(`${j.label}:${j.state}`));
    for (const label of ['a', 'b', 'c', 'd']) {
      q.add({
        kind: 'proxy',
        label,
        run: async ({ progress }) => {
          active++;
          peak = Math.max(peak, active);
          progress(0.5);
          await tick(20);
          active--;
        },
      });
    }
    await q.idle();
    expect(peak).toBe(2);
    expect(q.list().every((j) => j.state === 'done' && j.progress === 1)).toBe(true);
    expect(states.filter((s) => s.endsWith(':done'))).toHaveLength(4);
  });

  it('runs priority jobs (proxies) ahead of queued analysis, in order among themselves', async () => {
    const q = new JobQueue(1);
    const order: string[] = [];
    const job = (label: string, priority?: boolean) => q.add({ kind: 'proxy', label, priority, run: async () => void order.push(label) });
    job('running');
    await tick(5); // it has started: the next jobs queue behind it
    job('analysis-1');
    job('analysis-2');
    job('proxy-1', true);
    job('proxy-2', true);
    await q.idle();
    expect(order).toEqual(['running', 'proxy-1', 'proxy-2', 'analysis-1', 'analysis-2']);
  });

  it('cancels queued and running jobs; failures are captured', async () => {
    const q = new JobQueue(1);
    const running = q.add({ kind: 'proxy', label: 'run', run: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('x')))) });
    const queued = q.add({ kind: 'proxy', label: 'queued', run: async () => undefined });
    const bad = q.add({ kind: 'proxy', label: 'bad', run: async () => { throw new Error('boom'); } });
    await tick(10);
    expect(q.cancel(queued.id)).toBe(true);
    expect(q.cancel(running.id)).toBe(true);
    await q.idle();
    expect(q.get(running.id)?.state).toBe('canceled');
    expect(q.get(queued.id)?.state).toBe('canceled');
    expect(q.get(bad.id)).toMatchObject({ state: 'failed', error: 'boom' });
    expect(q.cancel(bad.id)).toBe(false);
  });
});

describe('mapLimit', () => {
  it('keeps order and bounds concurrency', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10 - n));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
