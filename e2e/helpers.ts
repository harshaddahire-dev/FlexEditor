import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Start a test from a pristine project: close whatever the server has open and delete the footage folder's
 * `.cutroom` (the sequence persists there — that is the feature, so tests must reset it explicitly).
 */
export async function resetProject(request: APIRequestContext): Promise<void> {
  await request.post('/api/project/close');
  await fs.rm(path.join(process.env.E2E_FOOTAGE!, '.cutroom'), { recursive: true, force: true });
  await fs.rm(path.join(process.env.E2E_FOOTAGE!, 'uploads'), { recursive: true, force: true });
  await fs.rm(path.join(process.env.E2E_FOOTAGE!, 'exports'), { recursive: true, force: true });
}

export type Clip = { id: string; start: number; duration: number; sourceIn: number; kind: string };
export type Seq = { revision: number; sequence: { timebase: { rate: number }; tracks: { name: string; items: Record<string, Clip> }[] } };
export const getSeq = async (page: Page): Promise<Seq> => (await page.request.get('/api/sequence')).json();
export const clipsOn = (s: Seq, name: string) => Object.values(s.sequence.tracks.find((t) => t.name === name)!.items).sort((a, b) => a.start - b.start);

export async function edit(page: Page, ops: unknown[], label: string) {
  const before = (await getSeq(page)).revision;
  const res = await page.request.post('/api/edit', { data: { ops, label, origin: 'user' } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await waitRevision(page, before + 1);
}
export async function undo(page: Page) {
  const before = (await getSeq(page)).revision;
  await page.request.post('/api/history/undo');
  await waitRevision(page, before + 1);
}
export async function waitRevision(page: Page, min: number) {
  await page.waitForFunction((m) => (window as unknown as { __cutroom: { useApp: { getState(): { revision: number } } } }).__cutroom.useApp.getState().revision >= m, min);
}

/** The interview's proxy exists, in the codec this browser reported, and the monitor is no longer waiting on it. */
export async function proxyReady(page: Page) {
  await page.waitForFunction(() => {
    const s = (window as unknown as { __cutroom: { useApp: { getState(): { media: Record<string, { name: string; status: { proxy: string }; proxy?: { codec: string } }> } } } }).__cutroom.useApp.getState();
    return Object.values(s.media).some((m) => m.name === 'interview.mp4' && m.status.proxy === 'done' && m.proxy?.codec === 'vp9' && !!(m as { audioProxyPath?: string }).audioProxyPath);
  }, undefined, { timeout: 60_000 });
  await expect(page.getByText('Preparing proxy…')).toBeHidden();
}

/** Paint every timeline frame 0…count-1 in turn and report, per frame, whether the monitor centre is white. */
export async function scan(page: Page, count: number) {
  return page.evaluate(async (count) => {
    const w = window as unknown as {
      __cutroom: {
        useApp: { getState(): { sequence: { width: number; height: number; timebase: { rate: number; fps: { num: number; den: number } } } } };
        useTimeline: { getState(): { setPlayhead(t: number, s: unknown): void } };
        viewer: { idle(): Promise<void>; pixel(x: number, y: number): number[] | null; shown: { ticks: number; layers: unknown[] } | null };
      };
    };
    const { useApp, useTimeline, viewer } = w.__cutroom;
    const seq = useApp.getState().sequence;
    const frame = (seq.timebase.rate * seq.timebase.fps.den) / seq.timebase.fps.num;
    const out: { n: number; white: boolean; dark: boolean; ticks: number; layers: number }[] = [];
    for (let n = 0; n < count; n++) {
      useTimeline.getState().setPlayhead(n * frame, seq);
      await viewer.idle();
      const p = viewer.pixel(seq.width / 2, seq.height / 2)!;
      out.push({ n, white: p[0]! > 200 && p[1]! > 200 && p[2]! > 200, dark: p[0]! < 40 && p[1]! < 40 && p[2]! < 40, ticks: viewer.shown!.ticks, layers: viewer.shown!.layers.length });
    }
    return { frame, out };
  }, count);
}


/** Open the footage folder, put the interview on the timeline (video + linked audio) and show the program monitor. */
export async function openFootageAndInsert(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Project folder path').fill(process.env.E2E_FOOTAGE!);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const bin = page.getByRole('listbox', { name: 'Media' });
  await expect(bin.getByRole('option')).toHaveCount(3);
  await bin.getByRole('option', { name: /interview\.mp4/ }).click();
  await page.keyboard.press(',');
  await page.getByRole('button', { name: 'Program', exact: true }).click();
  await proxyReady(page);
}

/** Like resetProject, for another footage folder. */
export async function resetFolder(request: APIRequestContext, dir: string): Promise<void> {
  await request.post('/api/project/close');
  await fs.rm(path.join(dir, '.cutroom'), { recursive: true, force: true });
}
