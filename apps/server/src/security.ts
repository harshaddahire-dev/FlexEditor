import path from 'node:path';
import { isSupportedExtension } from '@cutroom/core';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(hostHeader: string): string {
  // "localhost:5173" | "[::1]:3001" | "127.0.0.1"
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0]!.toLowerCase();
}

/**
 * The server can read arbitrary folders the user points it at, so it must only talk to pages served
 * from this machine. Rejecting foreign `Host` (DNS rebinding) and `Origin` (cross-site fetch) headers
 * closes the two ways a random website could reach it.
 */
export function isAllowedRequest(headers: { host?: string; origin?: string }, extraHosts: readonly string[] = []): boolean {
  const allowed = (h: string) => LOCAL_HOSTS.has(h) || extraHosts.includes(h);
  if (!headers.host || !allowed(hostnameOf(headers.host))) return false;
  if (headers.origin && headers.origin !== 'null') {
    try {
      if (!allowed(hostnameOf(new URL(headers.origin).host))) return false;
    } catch {
      return false;
    }
  } else if (headers.origin === 'null') {
    return false;
  }
  return true;
}

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

/** Validate and normalise a client-supplied relative upload path ("clips/take 1.mp4"). */
export function sanitizeRelativeUploadPath(input: string): string {
  const cleaned = input.replace(/\\/g, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) throw new UnsafePathError('Upload path must be relative.');
  const segments = cleaned.split('/').filter((s) => s.length > 0);
  if (!segments.length) throw new UnsafePathError('Upload path is empty.');
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || seg.startsWith('.')) throw new UnsafePathError(`Illegal path segment "${seg}".`);
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\u0000-\u001f]/.test(seg)) throw new UnsafePathError(`Illegal character in "${seg}".`);
  }
  if (!isSupportedExtension(segments[segments.length - 1]!)) {
    throw new UnsafePathError(`Unsupported file type "${path.extname(segments[segments.length - 1]!) || '(none)'}".`);
  }
  return segments.join('/');
}

/** Resolve `rel` under `root`, refusing anything that escapes it (symlink-free lexical check). */
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new UnsafePathError('Path escapes the project folder.');
  return abs;
}
