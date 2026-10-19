import { expect, test, type Page } from '@playwright/test';
import type { ExportInfo } from '@cutroom/core';
import { analyzeSync } from '../apps/server/test/helpers/media';
import { runBinary } from '../apps/server/src/proc';
import { edit, getSeq, openFootageAndInsert, resetProject } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

async function openRender(page: Page) {
  await page.getByRole('button', { name: 'Render', exact: true }).click();
  return page.getByRole('dialog', { name: 'Render' });
}
const lastExport = async (page: Page): Promise<ExportInfo> => ((await (await page.request.get('/api/exports')).json()) as ExportInfo[]).at(-1)!;

/** Indices of the white flash frames in a rendered file. */
async function flashFrames(file: string): Promise<number[]> {
  const r = await runBinary('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo', '-']);
  const out: number[] = [];
  for (let i = 0; i < r.stdout.length / 256; i++) {
    let sum = 0;
    for (let k = 0; k < 256; k++) sum += r.stdout[i * 256 + k]!;
    if (sum / 256 > 200) out.push(i);
  }
  return out;
}

test('render an H.264 MP4: audio mixed in the browser, picture by FFmpeg, 0 frames of A/V offset', async ({ page }) => {
  await openFootageAndInsert(page);
  const dlg = await openRender(page);
  await expect(dlg.getByRole('radio', { name: /H\.264 · MP4/ })).toHaveAttribute('aria-checked', 'true');
  await dlg.getByLabel('File name').fill('interview-final');
  await dlg.getByRole('button', { name: 'Start render' }).click();
  await expect(dlg.getByTestId('render-done')).toBeVisible({ timeout: 120_000 });
  await expect(dlg.getByText('interview-final.mp4')).toBeVisible();

  const info = await lastExport(page);
  expect(info).toMatchObject({ phase: 'done', request: { engine: 'ffmpeg', preset: 'h264-mp4' } });
  const seq = (await getSeq(page)).sequence as unknown as { width: number; height: number; timebase: { rate: number }; tracks: { name: string; items: Record<string, { start: number; duration: number }> }[] };
  expect(info.result).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac', width: seq.width, height: seq.height });
  const fps = 30;
  expect(info.result!.frames).toBe(Math.round(Math.max(...Object.values(seq.tracks.find((t) => t.name === 'V1')!.items).map((c) => (c.start + c.duration) / seq.timebase.rate)) * fps));

  const rep = await analyzeSync(info.output!);
  expect(rep.flashTimes.length).toBeGreaterThanOrEqual(5);
  expect(rep.beepTimes.length).toBe(rep.flashTimes.length);
  expect(rep.maxOffsetFrames).toBe(0);
  expect(rep.maxAbsOffsetMs).toBeLessThan(12);
  expect(await flashFrames(info.output!)).toEqual(rep.flashTimes.map((t) => Math.round(t * fps)));

  // the file can be downloaded from the dialog
  const href = await dlg.getByRole('link', { name: 'Download' }).getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.ok()).toBeTruthy();
  expect((await res.body()).length).toBe(info.result!.sizeBytes);
});

test('render with the browser encoder (draft from proxies): VP9/WebM, frame-exact, 0 frames of A/V offset, captions burned in', async ({ page }) => {
  await openFootageAndInsert(page);
  const supported = await page.evaluate(async () => typeof VideoEncoder !== 'undefined' && (await VideoEncoder.isConfigSupported({ codec: 'vp09.00.40.08', width: 640, height: 360, bitrate: 1_000_000, framerate: 30 })).supported);
  test.skip(!supported, 'this browser has no VP9 encoder');

  // one caption from 1.5 s to 2.5 s on its own track
  const seq0 = (await getSeq(page)).sequence;
  const R = seq0.timebase.rate;
  await edit(page, [{ type: 'addTrack', kind: 'caption', name: 'C1' }], 'Add caption track');
  const trackId = ((await (await page.request.get('/api/sequence')).json()) as { sequence: { tracks: { id: string; name: string }[] } }).sequence.tracks.find((t) => t.name === 'C1')!.id;
  await edit(page, [{ type: 'addCaption', trackId, start: Math.round(1.5 * R), duration: R, styleId: 'boxed', words: [{ text: 'Hello', start: Math.round(1.5 * R), end: Math.round(2 * R) }, { text: 'there', start: Math.round(2 * R), end: Math.round(2.5 * R) }] }], 'Add caption');

  const dlg = await openRender(page);
  await dlg.getByRole('radio', { name: /VP9 · WebM/ }).click();
  await dlg.getByRole('radio', { name: 'Both' }).click();
  await dlg.getByLabel(/Draft: render from proxies/).check();
  await dlg.getByLabel('File name').fill('draft');
  await dlg.getByRole('button', { name: 'Start render' }).click();
  await expect(dlg.getByTestId('render-done')).toBeVisible({ timeout: 120_000 });

  const info = await lastExport(page);
  expect(info.request).toMatchObject({ engine: 'webcodecs', preset: 'vp9-webm', draft: true });
  const seqDims = (await getSeq(page)).sequence as unknown as { width: number; height: number };
  expect(info.result).toMatchObject({ videoCodec: 'vp9', audioCodec: 'opus', width: seqDims.width, height: seqDims.height });
  expect(info.warnings.join()).toMatch(/proxies/);
  expect(info.sidecars.map((f) => f.split('.').pop()).sort()).toEqual(['srt', 'vtt']);

  const rep = await analyzeSync(info.output!);
  expect(rep.maxOffsetFrames).toBe(0);
  expect(rep.flashTimes.length).toBeGreaterThanOrEqual(5);
  // flashes land on exactly the frames the timeline put them on
  expect(await flashFrames(info.output!)).toEqual(rep.flashTimes.map((t) => Math.round(t * 30)));
  expect(rep.flashTimes.map((t) => Math.round(t * 30) % 30)).toEqual(rep.flashTimes.map(() => 0));

  // the boxed caption (white box) is in the lower part of frames 50 (1.67 s) … and absent at frame 20 (0.67 s); the box is mostly white with dark text, so compare averages
  const lower = async (n: number) => {
    const r = await runBinary('ffmpeg', ['-v', 'error', '-i', info.output!, '-vf', `select=eq(n\\,${n}),crop=iw/3:ih/12:iw/3:ih*0.8,scale=1:1,format=gray`, '-vsync', '0', '-frames:v', '1', '-f', 'rawvideo', '-']);
    return r.stdout[0]!;
  };
  const [without, withCaption] = [await lower(20), await lower(50)];
  expect(without).toBeLessThan(30);
  expect(withCaption).toBeGreaterThan(without + 25); // white box with dark text over black
});

test('ProRes always goes through FFmpeg, says why, and an audio-only render needs no picture', async ({ page }) => {
  await openFootageAndInsert(page);
  const dlg = await openRender(page);
  await dlg.getByRole('radio', { name: /ProRes/ }).click();
  await dlg.getByLabel('File name').fill('master');
  await dlg.getByRole('button', { name: 'Start render' }).click();
  await expect(dlg.getByTestId('render-done')).toBeVisible({ timeout: 120_000 });
  await expect(dlg.getByText(/encoded by FFmpeg/)).toBeVisible();
  const pro = await lastExport(page);
  expect(pro.result).toMatchObject({ videoCodec: 'prores', audioCodec: 'pcm_s24le' });
  expect((await analyzeSync(pro.output!)).maxOffsetFrames).toBe(0);

  await dlg.getByRole('button', { name: 'Render another' }).click();
  await dlg.getByRole('radio', { name: /Audio only/ }).click();
  await expect(dlg.getByText('Captions')).toHaveCount(0); // picture options disappear
  await dlg.getByLabel('File name').fill('mix');
  await dlg.getByRole('button', { name: 'Start render' }).click();
  await expect(dlg.getByTestId('render-done')).toBeVisible({ timeout: 120_000 });
  const wav = await lastExport(page);
  expect(wav.result).toMatchObject({ audioCodec: 'pcm_s24le' });
  expect(wav.result!.videoCodec).toBeUndefined();
});

test('cancel stops the render and leaves no file; the dialog explains and can start over', async ({ page }) => {
  await openFootageAndInsert(page);
  const dlg = await openRender(page);
  await dlg.getByRole('radio', { name: /ProRes/ }).click(); // the slowest preset
  await dlg.getByLabel('File name').fill('never');
  await dlg.getByRole('button', { name: 'Start render' }).click();
  await expect(dlg.getByRole('progressbar', { name: 'Render progress' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Cancel render' }).click();
  await expect(dlg.getByRole('alert')).toContainText('Export canceled');
  await expect.poll(async () => (await lastExport(page)).output ?? null).toBeNull();
  const jobs = (await (await page.request.get('/api/jobs')).json()) as { kind: string; state: string }[];
  await expect.poll(async () => ((await (await page.request.get('/api/jobs')).json()) as typeof jobs).filter((j) => j.kind === 'export').map((j) => j.state).at(-1)).toMatch(/canceled|failed/);
  await dlg.getByRole('button', { name: 'Back' }).click();
  await expect(dlg.getByRole('button', { name: 'Start render' })).toBeEnabled();
});
