import { isSupportedExtension } from '@cutroom/core';

export interface PendingUpload {
  file: File;
  /** Path relative to the dropped root, POSIX separators. */
  rel: string;
}

const readEntries = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => reader.readEntries(resolve, reject));

const entryFile = (entry: FileSystemFileEntry): Promise<File> => new Promise((resolve, reject) => entry.file(resolve, reject));

async function walk(entry: FileSystemEntry, out: PendingUpload[]): Promise<void> {
  if (entry.isFile) {
    if (!isSupportedExtension(entry.name)) return;
    const file = await entryFile(entry as FileSystemFileEntry);
    out.push({ file, rel: entry.fullPath.replace(/^\/+/, '') });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns batches (≤100); keep reading until it returns an empty one.
    for (;;) {
      const batch = await readEntries(reader);
      if (!batch.length) break;
      for (const child of batch) if (!child.name.startsWith('.')) await walk(child, out);
    }
  }
}

/** Collect supported media from a drop, descending into dropped folders. */
export async function collectDropped(dt: DataTransfer): Promise<PendingUpload[]> {
  // Entries must be grabbed synchronously — DataTransfer is cleared after the event handler yields.
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.() ?? null);
  const files = [...dt.files];
  const out: PendingUpload[] = [];
  if (entries.some(Boolean)) {
    for (const e of entries) if (e) await walk(e, out);
  } else {
    for (const file of files) if (isSupportedExtension(file.name)) out.push({ file, rel: file.name });
  }
  return out;
}

/** From an <input type="file"> (optionally webkitdirectory). */
export function collectFromInput(list: FileList | null): PendingUpload[] {
  if (!list) return [];
  return [...list]
    .filter((f) => isSupportedExtension(f.name))
    .map((file) => ({ file, rel: (file.webkitRelativePath || file.name).replace(/^\/+/, '') }));
}
