import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { AgentSettings, EditRequest, FfmpegStatus, ProviderInput, HealthResponse, ProjectResponse, ProxyCodec, ProxySettingsResponse, ServerEvent } from '@cutroom/core';
import { findWhisper, type WhisperInstall } from './analysis/whisper';
import type { ServerConfig } from './config';
import { AppDb } from './db';
import { checkFfmpeg } from './ffmpeg';
import { sendFile } from './files';
import { listDirectory } from './fsBrowse';
import { JobQueue } from './jobs';
import { EditRequestError } from './edit';
import { ProviderError, ProviderService } from './providers';
import { ProjectError, ProjectManager } from './project';
import { isAllowedRequest, resolveInside, sanitizeRelativeUploadPath, UnsafePathError } from './security';
import { exists } from './util';

export const APP_VERSION = '0.1.0';

export interface BuiltApp {
  app: FastifyInstance;
  providers: ProviderService;
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
  /** Override whisper.cpp discovery (tests). */
  whisper?: () => Promise<WhisperInstall | null>;
}

export async function buildApp(config: ServerConfig, options: BuildOptions = {}): Promise<BuiltApp> {
  const app = Fastify({ logger: options.logger ? { level: 'info' } : false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(fastifyWebsocket);

  let ffmpeg: FfmpegStatus = options.ffmpegStatus ?? (await checkFfmpeg(config.ffmpegPath, config.ffprobePath));
  const appDb = new AppDb(path.join(config.dataDir, 'app.sqlite'));
  const jobs = new JobQueue(options.jobConcurrency ?? 2);
  const providers = new ProviderService(appDb, path.join(config.dataDir, 'secret.key'));
  const whisper = options.whisper ?? (() => findWhisper(config.dataDir));
  const manager = new ProjectManager({
    whisper,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    ffmpegStatus: () => ffmpeg,
    jobs,
    appDb,
    proxyCodec: () => appDb.getSetting<ProxyCodec>('proxyCodec') ?? 'h264',
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
    if (err instanceof ProviderError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof EditRequestError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
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
  manager.on('session', (e) => {
    if (e.type === 'sequence') broadcast({ type: 'sequence', kind: e.kind, revision: e.revision, patches: e.patches as never, ...(e.sequence ? { sequence: e.sequence } : {}) });
    else broadcast({ type: 'history', history: manager.historyState() });
  });

  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    const hello: ServerEvent = { type: 'hello', jobs: jobs.list(), project: manager.summary() };
    socket.send(JSON.stringify(hello));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  /* ---- health / setup ---- */
  app.get('/api/health', async (): Promise<HealthResponse> => {
    const w = await whisper();
    return {
      app: 'cutroom',
      version: APP_VERSION,
      ffmpeg,
      dataDir: config.dataDir,
      hasProject: !!manager.current,
      whisper: w
        ? { available: true, model: path.basename(w.model) }
        : { available: false, hint: `Install whisper.cpp and a ggml model, then set WHISPER_CPP_BIN / WHISPER_MODEL (or put ggml-*.bin in ${path.join(config.dataDir, 'models')}).` },
    };
  });

  app.post('/api/health/recheck', async () => {
    ffmpeg = await checkFfmpeg(config.ffmpegPath, config.ffprobePath);
    return ffmpeg;
  });

  const requireFfmpeg = () => {
    if (!ffmpeg.ok) throw new ProjectError('ffmpeg_missing', ffmpeg.problems.join(' '), 503);
  };

  /**
   * The browser reports which video codec it can decode; proxies are made in that codec. Changing it regenerates
   * only the proxies that were made for a different one.
   */
  app.get('/api/settings/proxy-codec', async () => ({ codec: appDb.getSetting<ProxyCodec>('proxyCodec') ?? 'h264' }));
  app.put<{ Body: { codec: ProxyCodec } }>(
    '/api/settings/proxy-codec',
    { schema: { body: { type: 'object', required: ['codec'], properties: { codec: { enum: ['h264', 'vp9'] } } } } },
    async (req): Promise<ProxySettingsResponse> => {
      const { codec } = req.body;
      const encoder = codec === 'vp9' ? 'libvpx-vp9' : 'libx264';
      if (!ffmpeg.encoders[encoder]) throw new ProjectError('encoder_missing', `ffmpeg has no ${encoder} encoder, so ${codec.toUpperCase()} proxies cannot be made.`, 409);
      appDb.setSetting('proxyCodec', codec);
      const requeued = manager.current ? await manager.refreshProxies() : 0;
      return { codec, requeued };
    },
  );


  /* ---- model providers: keys are write-only; the browser only ever sees ProviderInfo ---- */
  const kinds = ['openrouter', 'openai', 'anthropic', 'gemini', 'custom'];
  const providerBody = {
    type: 'object',
    properties: {
      kind: { enum: kinds },
      name: { type: 'string', maxLength: 80 },
      baseUrl: { type: 'string', maxLength: 300 },
      apiKey: { type: 'string', maxLength: 600 },
      defaultModel: { type: 'string', maxLength: 200 },
    },
  } as const;
  app.get('/api/providers', async () => ({ providers: providers.store.list(), agent: providers.store.agent() }));
  app.post<{ Body: ProviderInput }>('/api/providers', { schema: { body: { ...providerBody, required: ['kind'] } } }, async (req, reply) => {
    return reply.code(201).send(providers.store.add(req.body));
  });
  app.patch<{ Params: { id: string }; Body: Partial<ProviderInput> }>('/api/providers/:id', { schema: { body: providerBody } }, async (req) => {
    const info = providers.store.update(req.params.id, req.body);
    providers.forget(req.params.id);
    return info;
  });
  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (req) => {
    providers.store.remove(req.params.id);
    providers.forget(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/providers/:id/test', async (req) => providers.test(req.params.id));
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/api/providers/:id/models', async (req) => {
    try {
      return { models: await providers.models(req.params.id, req.query.refresh === '1') };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      return { models: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
  app.put<{ Body: AgentSettings }>(
    '/api/agent/settings',
    { schema: { body: { type: 'object', required: ['effort', 'mode'], properties: { providerId: { type: 'string' }, model: { type: 'string' }, effort: { enum: ['off', 'low', 'medium', 'high', 'max'] }, mode: { enum: ['ask', 'auto', 'full'] } } } } },
    async (req) => providers.store.setAgent(req.body),
  );

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
    return { summary: manager.summary()!, project, revision: manager.revision, history: manager.historyState() };
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

  app.post<{ Body?: { includeIgnored?: boolean } }>('/api/project/rescan', async (req) => {
    requireFfmpeg();
    manager.requireProject();
    return manager.scan({ includeIgnored: req.body?.includeIgnored === true });
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

  /* ---- editing: one validated, atomic, undoable transaction per request ---- */
  app.get('/api/sequence', async () => {
    const session = manager.requireSession();
    return { revision: session.editor.revision, sequence: session.state, history: manager.historyState() };
  });

  app.post<{ Body: EditRequest }>(
    '/api/edit',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ops'],
          properties: {
            ops: { type: 'array', minItems: 1, items: { type: 'object' } },
            label: { type: 'string', maxLength: 300 },
            origin: { type: 'string' },
            baseRevision: { type: 'integer' },
          },
        },
      },
    },
    async (req) => manager.edit(req.body),
  );

  app.post('/api/history/undo', async () => manager.requireSession().undo());
  app.post('/api/history/redo', async () => manager.requireSession().redo());
  app.get('/api/history', async () => {
    manager.requireSession();
    return manager.historyState();
  });
  app.post<{ Body: { snapshotId: string } }>(
    '/api/history/restore',
    { schema: { body: { type: 'object', required: ['snapshotId'], properties: { snapshotId: { type: 'string' } } } } },
    async (req) => manager.requireSession().restore(req.body.snapshotId),
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
      manager.clearIgnored(req.body.path);
      const outcome = await manager.importFile(path.resolve(req.body.path));
      if (outcome.kind === 'rejected') return reply.code(422).send({ error: 'rejected', message: outcome.reason });
      return outcome.media;
    },
  );

  app.get<{ Params: { id: string; kind: string } }>('/api/media/:id/file/:kind', async (req, reply) => {
    const kind = req.params.kind;
    if (kind !== 'original' && kind !== 'proxy' && kind !== 'audio' && kind !== 'poster') {
      throw new ProjectError('bad_request', 'kind must be original, proxy, audio or poster.');
    }
    const media = manager.findMedia(req.params.id);
    if (!media) throw new ProjectError('no_such_media', 'No such media.', 404);
    const file = manager.mediaFile(media, kind);
    if (!file) throw new ProjectError('not_ready', `The ${kind} is not available yet.`, 404);
    return sendFile(req, reply, file, kind === 'original' ? 'no-cache' : 'private, max-age=0, must-revalidate');
  });

  /** Cached analysis results: waveform(.bin), silences, loudness, beats, scenes, filmstrip(.jpg), transcript. */
  app.get<{ Params: { id: string; name: string } }>('/api/media/:id/analysis/:name', async (req, reply) => {
    const media = manager.findMedia(req.params.id);
    if (!media) throw new ProjectError('no_such_media', 'No such media.', 404);
    const entry = manager.analysisFile(media, req.params.name);
    if (!entry) throw new ProjectError('bad_request', `Unknown analysis "${req.params.name}".`);
    if (!(await exists(entry.file))) throw new ProjectError('not_ready', `${req.params.name} is not available yet.`, 404);
    void reply.type(entry.type);
    return sendFile(req, reply, entry.file, 'private, max-age=0, must-revalidate');
  });

  /** Re-run analyses that failed or were unavailable (e.g. after installing whisper.cpp). */
  app.post<{ Params: { id: string } }>('/api/media/:id/analyze', async (req) => {
    if (!manager.findMedia(req.params.id)) throw new ProjectError('no_such_media', 'No such media.', 404);
    await manager.analysis.retry(req.params.id);
    return manager.findMedia(req.params.id);
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

  return { app, manager, jobs, appDb, providers };
}
