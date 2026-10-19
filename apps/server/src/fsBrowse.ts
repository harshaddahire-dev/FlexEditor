import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FsEntry, FsListing } from '@cutroom/core';
import { isSupportedExtension } from '@cutroom/core';
import { exists } from './util';

async function quickLinks(): Promise<{ label: string; path: string }[]> {
  const home = os.homedir();
  const candidates: [string, string][] = [
    ['Home', home],
    ['Desktop', path.join(home, 'Desktop')],
    ['Documents', path.join(home, 'Documents')],
    ['Videos', path.join(home, process.platform === 'darwin' ? 'Movies' : 'Videos')],
    ['Downloads', path.join(home, 'Downloads')],
  ];
  const out: { label: string; path: string }[] = [];
  for (const [label, p] of candidates) if (await exists(p)) out.push({ label, path: p });
  return out;
}

async function windowsDrives(): Promise<FsEntry[]> {
  const out: FsEntry[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (await exists(root)) out.push({ name: root, path: root, isDir: true });
  }
  return out;
}

/** List sub-folders of `dir` for the "open folder" picker (browsers cannot hand us absolute paths). */
export async function listDirectory(dir?: string): Promise<FsListing> {
  const links = await quickLinks();
  if (!dir && process.platform === 'win32') {
    return { path: '', parent: null, entries: await windowsDrives(), mediaFiles: 0, quickLinks: links };
  }
  const target = path.resolve(dir || os.homedir());
  const dirents = await fs.readdir(target, { withFileTypes: true });
  const entries: FsEntry[] = [];
  let mediaFiles = 0;
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    if (d.isDirectory()) entries.push({ name: d.name, path: path.join(target, d.name), isDir: true });
    else if (d.isFile() && isSupportedExtension(d.name)) mediaFiles++;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? (process.platform === 'win32' ? '' : null) : parent,
    entries,
    mediaFiles,
    quickLinks: links,
  };
}
