import path from 'node:path';

export const CUTROOM_DIR = '.cutroom';

export const cutroomDir = (folder: string): string => path.join(folder, CUTROOM_DIR);
export const projectJsonPath = (folder: string): string => path.join(cutroomDir(folder), 'project.json');
export const indexDbPath = (folder: string): string => path.join(cutroomDir(folder), 'index.sqlite');
export const proxiesDir = (folder: string): string => path.join(cutroomDir(folder), 'proxies');
export const cacheDir = (folder: string, mediaId?: string): string =>
  mediaId ? path.join(cutroomDir(folder), 'cache', mediaId) : path.join(cutroomDir(folder), 'cache');
export const historyDir = (folder: string): string => path.join(cutroomDir(folder), 'history');

/** Project-relative POSIX path when `abs` is inside `folder`, otherwise the absolute path. */
export function toStoredPath(folder: string, abs: string): string {
  const rel = path.relative(folder, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return abs;
}

export function fromStoredPath(folder: string, stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(folder, ...stored.split('/'));
}
