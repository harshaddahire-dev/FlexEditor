import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtures, generateColorAsset } from '../apps/server/test/helpers/media';

/** Builds a small footage folder (nested, with a junk file) for the specs and exports its path. */
export default async function globalSetup(): Promise<void> {
  const fx = await fixtures();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-e2e-footage-'));
  await fs.mkdir(path.join(root, 'day1'), { recursive: true });
  await fs.copyFile(fx.sync, path.join(root, 'day1', 'interview.mp4'));
  await fs.copyFile(fx.rotated, path.join(root, 'day1', 'phone-vertical.mp4'));
  await fs.copyFile(fx.tone, path.join(root, 'music.wav'));
  await fs.writeFile(path.join(root, 'notes.txt'), 'not media');
  // a second, separate folder of solid colours for pixel-exact effect/transition tests
  const colors = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-e2e-colors-'));
  await generateColorAsset(path.join(colors, 'red.mp4'), 'red');
  await generateColorAsset(path.join(colors, 'blue.mp4'), 'blue');
  process.env.E2E_COLORS = colors;
  process.env.E2E_FOOTAGE = root;
  process.env.E2E_UPLOAD = fx.still;
}
