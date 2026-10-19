import { createReadStream, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Parse a single-range `Range: bytes=a-b` header. Returns null for absent, 'invalid' for unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** Stream a local file with HTTP Range support (needed for <video>/WebCodecs seeking). */
export async function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, cache = 'no-cache'): Promise<FastifyReply> {
  let st: Stats;
  try {
    st = await fs.stat(file);
  } catch {
    return reply.code(404).send({ error: 'not_found', message: 'File not found on disk.' });
  }
  const range = parseRange(req.headers.range, st.size);
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', mimeFor(file)).header('Cache-Control', cache);
  reply.header('ETag', `W/"${st.size}-${Math.floor(st.mtimeMs)}"`);
  if (range === 'invalid') return reply.code(416).header('Content-Range', `bytes */${st.size}`).send();
  if (range) {
    reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`).header('Content-Length', range.end - range.start + 1);
    return reply.send(createReadStream(file, { start: range.start, end: range.end }));
  }
  reply.header('Content-Length', st.size);
  return reply.send(createReadStream(file));
}
