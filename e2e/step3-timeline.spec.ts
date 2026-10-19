import { resetProject } from './helpers';
import { expect, test, type Page } from '@playwright/test';

const footage = () => process.env.E2E_FOOTAGE!;

function watchErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => r.status() >= 400 && !r.url().includes('/api/health') && errors.push(`http ${r.status()}: ${r.url()}`));
  return () => errors;
}

test.beforeEach(async ({ request }) => {
  await resetProject(request);
});

async function openProject(page: Page) {
  await page.goto('/');
  await page.getByLabel('Project folder path').fill(footage());
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Media' }).getByRole('option')).toHaveCount(3);
}

type Seq = { revision: number; sequence: { timebase: { rate: number }; tracks: { name: string; id: string; items: Record<string, { id: string; start: number; duration: number; sourceIn: number; mediaId: string; kind: string }> }[] } };
const getSeq = async (page: Page): Promise<Seq> => (await page.request.get('/api/sequence')).json();
const itemsOn = (s: Seq, name: string) => Object.values(s.sequence.tracks.find((t) => t.name === name)!.items).sort((a, b) => a.start - b.start);

/** Page-space pixel for a timeline tick / track name, using the live view. */
async function px(page: Page, ticks: number, trackName?: string) {
  return page.evaluate(
    ({ ticks, trackName }) => {
      const w = window as unknown as { __cutroom: { useApp: { getState(): { sequence: Seq['sequence'] } }; useTimeline: { getState(): { view: { pps: number; scrollX: number; scrollY: number } } } } };
      const seq = w.__cutroom.useApp.getState().sequence;
      const v = w.__cutroom.useTimeline.getState().view;
      const c = document.querySelector('[data-testid="timeline-canvas"]')!.getBoundingClientRect();
      const x = c.left + (ticks / seq.timebase.rate) * v.pps - v.scrollX;
      let y = c.top + 13;
      if (trackName) {
        const order = [...seq.tracks.filter((t) => t.name.startsWith('C')).reverse(), ...seq.tracks.filter((t) => t.name.startsWith('G')).reverse(), ...seq.tracks.filter((t) => t.name.startsWith('V')).reverse(), ...seq.tracks.filter((t) => t.name.startsWith('A'))];
        let acc = 0;
        for (const t of order as unknown as { name: string; height: number }[]) {
          if (t.name === trackName) { y = c.top + 26 + acc + t.height / 2 - v.scrollY; break; }
          acc += t.height + 1;
        }
      }
      return { x, y };
    },
    { ticks, trackName },
  );
}

test('build, cut, move, trim, undo and delete on the timeline with mouse and keyboard', async ({ page }) => {
  const errors = watchErrors(page);
  await openProject(page);
  const bin = page.getByRole('listbox', { name: 'Media' });

  // empty timeline invites the next action
  await expect(page.getByText('The timeline is empty.')).toBeVisible();

  // --- insert at the playhead with the keyboard: select media, press ","
  await bin.getByRole('option', { name: /interview\.mp4/ }).click();
  await page.keyboard.press(',');
  await expect(page.getByText('The timeline is empty.')).toBeHidden();
  let s = await getSeq(page);
  const R = s.sequence.timebase.rate;
  expect(itemsOn(s, 'V1')).toHaveLength(1);
  expect(itemsOn(s, 'A1')).toHaveLength(1);
  expect(itemsOn(s, 'V1')[0]).toMatchObject({ start: 0, duration: 6 * R });
  expect(itemsOn(s, 'A1')[0]).toMatchObject({ start: 0, duration: 6 * R });

  // the canvas really painted the clip (clip colour differs from the lane background)
  const painted = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="timeline-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const seq = (window as unknown as { __cutroom: { useApp: { getState(): { sequence: { tracks: { kind: string; height: number }[] } } } } }).__cutroom.useApp.getState().sequence;
    const v2 = seq.tracks.filter((t) => t.kind === 'video').at(-1)!.height; // V2 is the top lane
    const p = ctx.getImageData(Math.round(60 * dpr), Math.round((26 + v2 + 1 + 20) * dpr), 1, 1).data; // inside V1, below the empty V2 lane
    return [p[0], p[1], p[2]];
  });
  expect(painted).not.toEqual([11, 12, 14]); // not the --bg-0 lane colour

  // --- click the ruler to move the playhead: timecode readout follows
  const at3 = await px(page, 3 * R);
  await page.mouse.click(at3.x, at3.y);
  await expect(page.getByLabel('Playhead timecode')).toHaveText('00:00:03:00');
  await page.getByRole('button', { name: 'Program', exact: true }).click();
  await expect(page.getByLabel('Timecode', { exact: true })).toHaveText('00:00:03:00'); // the program monitor shows the same

  // --- blade tool: press C, click the clip at 3 s → linked split of video and audio
  await page.keyboard.press('c');
  const bladeAt = await px(page, 3 * R, 'V1');
  await page.mouse.click(bladeAt.x, bladeAt.y);
  await expect.poll(async () => itemsOn(await getSeq(page), 'V1').length).toBe(2);
  s = await getSeq(page);
  expect(itemsOn(s, 'A1')).toHaveLength(2);
  expect(itemsOn(s, 'V1')[1]).toMatchObject({ start: 3 * R, duration: 3 * R, sourceIn: 3 * R });
  expect(itemsOn(s, 'A1')[1]).toMatchObject({ start: 3 * R, sourceIn: 3 * R });

  // --- undo / redo restore exactly (keyboard)
  await page.keyboard.press('v');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => itemsOn(await getSeq(page), 'V1').length).toBe(1);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => itemsOn(await getSeq(page), 'V1').length).toBe(2);

  // --- drag the second half to the right: it moves (linked audio with it), frame-aligned
  const grab = await px(page, 4.5 * R, 'V1');
  const drop = await px(page, 6.5 * R, 'V1');
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move((grab.x + drop.x) / 2, grab.y, { steps: 5 });
  await page.mouse.move(drop.x, grab.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => itemsOn(await getSeq(page), 'V1')[1]!.start).toBeGreaterThan(3 * R);
  s = await getSeq(page);
  const moved = itemsOn(s, 'V1')[1]!;
  expect(moved.start % (R / 30)).toBe(0);
  expect(itemsOn(s, 'A1')[1]!.start).toBe(moved.start); // linked partner moved identically
  expect(moved.start - 3 * R).toBeGreaterThan(1.5 * R);

  // --- trim: drag the left clip's right edge back to 2 s
  const edge = await px(page, 3 * R, 'V1');
  const to2 = await px(page, 2 * R, 'V1');
  await page.mouse.move(edge.x - 2, edge.y);
  await page.mouse.down();
  await page.mouse.move(to2.x + 40, edge.y, { steps: 6 });
  await page.mouse.move(to2.x, edge.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => itemsOn(await getSeq(page), 'V1')[0]!.duration).toBeLessThan(3 * R);
  s = await getSeq(page);
  expect(Math.abs(itemsOn(s, 'V1')[0]!.duration - 2 * R)).toBeLessThanOrEqual(R / 15); // within a couple of frames (snaps to the playhead/edges)
  expect(itemsOn(s, 'A1')[0]!.duration).toBe(itemsOn(s, 'V1')[0]!.duration);

  // --- select + delete
  await page.keyboard.press('Escape');
  const body = await px(page, 1 * R, 'V1');
  await page.mouse.click(body.x, body.y);
  await page.keyboard.press('Delete');
  await expect.poll(async () => itemsOn(await getSeq(page), 'V1').length).toBe(1);
  expect(itemsOn(await getSeq(page), 'A1')).toHaveLength(1);

  expect(errors()).toEqual([]);
});

test('transport, shuttle keys, in/out, markers, zoom and the command palette', async ({ page }) => {
  const errors = watchErrors(page);
  await openProject(page);
  await page.getByRole('listbox', { name: 'Media' }).getByRole('option', { name: /interview\.mp4/ }).click();
  await page.keyboard.press(',');
  await expect.poll(async () => itemsOn(await getSeq(page), 'V1').length).toBe(1);

  const tc = page.getByLabel('Playhead timecode');
  // Space plays from the playhead; it advances in whole frames and stops again
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  await page.keyboard.press('Space');
  const stopped = await tc.textContent();
  expect(stopped).not.toBe('00:00:00:00');
  expect(stopped).toMatch(/^00:00:0[0-2]:\d\d$/);
  await page.waitForTimeout(200);
  expect(await tc.textContent()).toBe(stopped); // really stopped

  // frame stepping and edit-point navigation
  await page.keyboard.press('Home');
  await expect(tc).toHaveText('00:00:00:00');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(tc).toHaveText('00:00:00:02');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(tc).toHaveText('00:00:00:12');
  await page.keyboard.press('ArrowDown'); // next edit point = the clip end
  await expect(tc).toHaveText('00:00:06:00');
  await page.keyboard.press('ArrowUp');
  await expect(tc).toHaveText('00:00:00:00');
  await page.keyboard.press('End');
  await expect(tc).toHaveText('00:00:06:00');

  // L plays forward from the playhead and doubles on a second press (clamped at the end here: stops)
  await page.keyboard.press('Home');
  await page.keyboard.press('l');
  await page.waitForTimeout(300);
  await page.keyboard.press('k');
  expect(await tc.textContent()).not.toBe('00:00:00:00');

  // markers and in/out
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('m');
  await page.keyboard.press('i');
  await page.keyboard.press('End');
  await page.keyboard.press('o');
  await expect.poll(async () => (await getSeq(page)).sequence).toMatchObject({ markers: [{ time: (await getSeq(page)).sequence.timebase.rate / 3 }] });
  const { inP, outP } = await page.evaluate(() => {
    const t = (window as unknown as { __cutroom: { useTimeline: { getState(): { inPoint: number; outPoint: number } } } }).__cutroom.useTimeline.getState();
    return { inP: t.inPoint, outP: t.outPoint };
  });
  expect(inP).toBe(10 * (48000 / 30));
  expect(outP).toBe(6 * 48000);

  // zoom keys change the scale; fit restores a whole-clip view
  const pps = () => page.evaluate(() => (window as unknown as { __cutroom: { useTimeline: { getState(): { view: { pps: number } } } } }).__cutroom.useTimeline.getState().view.pps);
  const p0 = await pps();
  await page.keyboard.press('=');
  expect(await pps()).toBeGreaterThan(p0);
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  expect(await pps()).toBeLessThan(p0);
  await page.keyboard.press('Shift+z');
  expect((await pps()) * 10).toBeLessThan(await page.evaluate(() => window.innerWidth * 1.2)); // 10 s minimum fits the screen

  // ⌘K / Ctrl+K command palette: search, run, close
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Type a command…');
  await expect(input).toBeVisible();
  await input.fill('blade');
  await expect(page.getByRole('option', { name: /Blade tool/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(page.getByRole('button', { name: 'Blade (C)' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();

  // track controls dispatch real edits
  await page.getByRole('button', { name: 'Lock V1' }).click();
  await expect.poll(async () => (await getSeq(page)).sequence.tracks.find((t) => t.name === 'V1')).toMatchObject({ locked: true });
  await page.keyboard.press('v');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+c'); // split at playhead: V1 is locked, but A1 is not
  await expect.poll(async () => itemsOn(await getSeq(page), 'A1').length).toBe(2);
  expect(itemsOn(await getSeq(page), 'V1')).toHaveLength(1); // locked track untouched
  expect(errors()).toEqual([]);
});

test('an illegal edit is refused with a reason and nothing changes', async ({ page }) => {
  await openProject(page);
  await page.getByRole('listbox', { name: 'Media' }).getByRole('option', { name: /interview\.mp4/ }).click();
  await page.keyboard.press(',');
  await expect.poll(async () => itemsOn(await getSeq(page), 'V1').length).toBe(1);
  const before = (await getSeq(page)).revision;
  await page.keyboard.press('Home');
  await page.keyboard.press('c'); // blade tool
  await page.keyboard.press('Shift+c'); // split at 0: not inside the clip
  await expect(page.getByRole('alert')).toContainText(/no clip under the playhead/i);
  expect((await getSeq(page)).revision).toBe(before);
  await page.keyboard.press('v');
  // deleting with nothing selected says so
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  await expect(page.getByRole('alert')).toContainText(/nothing is selected/i);
});

test('transport keys keep working after clicking a bin item (the bin must not steal the arrow keys)', async ({ page }) => {
  await openProject(page);
  const bin = page.getByRole('listbox', { name: 'Media' });
  await bin.getByRole('option', { name: /music\.wav/ }).click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByLabel('Playhead timecode')).toHaveText('00:00:00:11');
  // the selected media is still the one that was clicked
  await expect(bin.getByRole('option', { name: /music\.wav/ })).toHaveAttribute('aria-selected', 'true');
  // a second click on another tile and Enter/Space still select via the keyboard
  await bin.getByRole('option', { name: /phone-vertical/ }).focus();
  await page.keyboard.press('Enter');
  await expect(bin.getByRole('option', { name: /phone-vertical/ })).toHaveAttribute('aria-selected', 'true');
});
