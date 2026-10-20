import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const FP_CHUNK = 64 * 1024;

/**
 * Cheap content fingerprint: size + first and last 64 KiB. Stable across renames/moves, which is what
 * relinking needs, and fast enough to run over a whole folder of multi-GB camera files.
 */
export async function fingerprintFile(file: string, size: number): Promise<string> {
  const h = createHash('sha1');
  h.update(String(size));
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(FP_CHUNK, size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (size > FP_CHUNK) {
      const tailLen = Math.min(FP_CHUNK, size - FP_CHUNK);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      h.update(tail);
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `fs.rename` that survives Windows: antivirus, the search indexer and OneDrive/Dropbox sync briefly hold files that were just
 * written, and the rename then fails with EPERM/EBUSY/EACCES. Retrying for a couple of seconds gets past all of them.
 */
export async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 50 + attempt * 25));
    }
  }
}

/** Write JSON atomically: temp file in the same directory, then rename over the target. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await renameRetry(tmp, file);
}
