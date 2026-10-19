import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FfmpegStatus, HealthResponse, ProjectResponse, ServerEvent } from '@cutroom/core';
import type { ServerConfig } from './config';
import { AppDb } from './db';
import { checkFfmpeg } from './ffmpeg';
import { sendFile } from './files';
import { listDirectory } from './fsBrowse';
import { JobQueue } from './jobs';
import { ProjectError, ProjectManager } from './project';
import { isAllowedRequest, resolveInside, sanitizeRelativeUploadPath, UnsafePathError } from './security';
import { exists } from './util';

export const APP_VERSION = '0.1.0';

export interface BuiltApp {
  app: FastifyInstance;
  manager: ProjectManager;
  jobs: JobQueue;
  appDb: AppDb;
}

export interface BuildOptions {
  logger?: boolean;
  /** Skip the ffmpeg probe and use this status (tests). */
  ffmpegStatus?: FfmpegStatus;
  saveDelayMs?: number;
  jobConcurrency?: number;
}

export async function buildApp(config: ServerConfig, options: BuildOptions = {}): Promise<BuiltApp> {
  const app = Fastify({ logger: options.logger ? { level: 'info' } : false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(fastifyWebsocket);

  let ffmpeg: FfmpegStatus = options.ffmpegStatus ?? (await checkFfmpeg(config.ffmpegPath, config.ffprobePath));
  const appDb = new AppDb(path.join(config.dataDir, 'app.sqlite'));
  const jobs = new JobQueue(options.jobConcurrency ?? 2);
  const manager = new ProjectManager({
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    ffmpegStatus: () => ffmpeg,
    jobs,
    appDb,
    saveDelayMs: options.saveDelayMs,
  });

  /* ---- only talk to pages on this machine ---- */
  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedRequest({ host: req.headers.host, origin: req.headers.origin as string | undefined })) {
      return reply.code(403).send({ error: 'forbidden', message: 'Cross-origin requests are not allowed.' });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof ProjectError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof UnsafePathError) return reply.code(400).send({ error: 'unsafe_path', message: err.message });
    if (err.validation) return reply.code(400).send({ error: 'bad_request', message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: err.message });
  });

  // Raw uploads: hand the request stream to the route instead of buffering multi-GB files.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  /* ---- realtime ---- */
  const sockets = new Set<{ send(data: string): void; readyState: number }>();
  const broadcast = (event: ServerEvent) => {
    const data = JSON.stringify(event);
    for (const s of sockets) if (s.readyState === 1) s.send(data);
  };
  jobs.on('update', (job) => broadcast({ type: 'job', job }));
  manager.on('media', (media) => broadcast({ type: 'media', media }));
  manager.on('mediaRemoved', (mediaId) => broadcast({ type: 'mediaRemoved', mediaId }));
  manager.on('project', (project) => broadcast({ type: 'project', project }));
  manager.on('scan', (report) => broadcast({ type: 'scan', report }));

  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    const hello: ServerEvent = { type: 'hello', jobs: jobs.list(), project: manager.summary() };
    socket.send(JSON.stringify(hello));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  /* ---- health / setup ---- */
  app.get('/api/health', async (): Promise<HealthResponse> => ({
    app: 'cutroom',
    version: APP_VERSION,
    ffmpeg,
    dataDir: config.dataDir,
    hasProject: !!manager.current,
  }));

  app.post('/api/health/recheck', async () => {
    ffmpeg = await checkFfmpeg(config.ffmpegPath, config.ffprobePath);
    return ffmpeg;
  });

  const requireFfmpeg = () => {
    if (!ffmpeg.ok) throw new ProjectError('ffmpeg_missing', ffmpeg.problems.join(' '), 503);
  };

  /* ---- filesystem picker ---- */
  app.get<{ Querystring: { path?: string } }>('/api/fs/list', async (req) => {
    try {
      return await listDirectory(req.query.path);
    } catch (e) {
      throw new ProjectError('fs_error', (e as Error).message, 400);
    }
  });

  /* ---- project ---- */
  const projectResponse = (): ProjectResponse => {
    const { project } = manager.requireProject();
    return { summary: manager.summary()!, project };
  };

  app.get('/api/recent', async () => appDb.recent());
  app.delete<{ Querystring: { path: string } }>('/api/recent', async (req) => {
    appDb.forgetRecent(req.query.path);
    return { ok: true };
  });

  app.post<{ Body: { path: string } }>(
    '/api/project/open',
    { schema: { body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } } },
    async (req) => {
      requireFfmpeg();
      await manager.open(req.body.path);
      return projectResponse();
    },
  );

  app.get('/api/project', async () => projectResponse());

  app.post('/api/project/close', async () => {
    await manager.close();
    return { ok: true };
  });

  app.post('/api/project/rescan', async () => {
    requireFfmpeg();
    manager.requireProject();
    return manager.scan();
  });

  app.patch<{ Body: { width?: number; height?: number; fps?: { num: number; den: number } } }>(
    '/api/project/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            width: { type: 'integer' },
            height: { type: 'integer' },
            fps: { type: 'object', required: ['num', 'den'], properties: { num: { type: 'integer' }, den: { type: 'integer' } } },
          },
        },
      },
    },
    async (req) => manager.updateSettings(req.body),
  );

  /* ---- upload (raw body, streamed to disk under <project>/uploads) ---- */
  app.put<{ Querystring: { path: string } }>('/api/project/upload', async (req, reply) => {
    requireFfmpeg();
    const { folder } = manager.requireProject();
    if (!req.query.path) throw new ProjectError('bad_request', 'Missing ?path= query parameter.');
    const rel = sanitizeRelativeUploadPath(req.query.path);
    const uploads = path.join(folder, 'uploads');
    let dest = resolveInside(uploads, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    for (let n = 1; await exists(dest); n++) {
      const ext = path.extname(rel);
      dest = resolveInside(uploads, `${rel.slice(0, rel.length - ext.length)} (${n})${ext}`);
    }
    const tmp = `${dest}.uploading`;
    try {
      await pipeline(req.body as Readable, createWriteStream(tmp));
      await fs.rename(tmp, dest);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw new ProjectError('upload_failed', `Upload interrupted: ${(e as Error).message}`, 400);
    }
    const outcome = await manager.importFile(dest);
    if (outcome.kind === 'rejected') {
      await fs.rm(dest, { force: true });
      return reply.code(422).send({ error: 'rejected', message: outcome.reason });
    }
    return reply.code(201).send(outcome.media);
  });

  /* ---- media ---- */
  app.get('/api/media', async () => manager.requireProject().project.media);

  app.post<{ Body: { path: string } }>(
    '/api/media/import',
    { schema: { body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } } },
    async (req, reply) => {
      requireFfmpeg();
      manager.requireProject();
      const outcome = await manager.importFile(path.resolve(req.body.path));
      if (outcome.kind === 'rejected') return reply.code(422).send({ error: 'rejected', message: outcome.reason });
      return outcome.media;
    },
  );

  app.get<{ Params: { id: string; kind: string } }>('/api/media/:id/file/:kind', async (req, reply) => {
    const kind = req.params.kind;
    if (kind !== 'original' && kind !== 'proxy' && kind !== 'poster') {
      throw new ProjectError('bad_request', 'kind must be original, proxy or poster.');
    }
    const media = manager.findMedia(req.params.id);
    if (!media) throw new ProjectError('no_such_media', 'No such media.', 404);
    const file = manager.mediaFile(media, kind);
    if (!file) throw new ProjectError('not_ready', `The ${kind} is not available yet.`, 404);
    return sendFile(req, reply, file, kind === 'original' ? 'no-cache' : 'private, max-age=0, must-revalidate');
  });

  app.delete<{ Params: { id: string } }>('/api/media/:id', async (req) => {
    await manager.removeMedia(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/media/:id/reproxy', async (req) => {
    requireFfmpeg();
    return manager.reproxy(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { path: string; force?: boolean } }>(
    '/api/media/:id/relink',
    { schema: { body: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, force: { type: 'boolean' } } } } },
    async (req) => {
      requireFfmpeg();
      return manager.relink(req.params.id, req.body.path, req.body.force ?? false);
    },
  );

  app.get<{ Params: { id: string } }>('/api/media/:id/relink-candidates', async (req) => manager.relinkCandidates(req.params.id));

  /* ---- jobs ---- */
  app.get('/api/jobs', async () => jobs.list());
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) => ({ canceled: jobs.cancel(req.params.id) }));

  /* ---- production: serve the built web app ---- */
  if (config.webDist && (await exists(config.webDist))) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found', message: `No route ${req.method} ${req.url}` });
    });
  }

  app.addHook('onClose', async () => {
    await manager.close();
    appDb.close();
  });

  return { app, manager, jobs, appDb };
}
