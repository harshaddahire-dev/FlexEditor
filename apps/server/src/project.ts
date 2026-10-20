import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type EditRequest,
  type EditResponse,
  type HistoryState,
  type Sequence,
  createSequence,
  DEFAULT_PROJECT_SETTINGS,
  type FfmpegStatus,
  type Media,
  type Project,
  type ProjectSettings,
  type ProxyCodec,
  type ProjectSummary,
  type ScanReport,
  emptyStatus,
  isSupportedExtension,
  toNumber,
} from '@cutroom/core';
import { MediaAnalysis } from './analysis/pipeline';
import { SERVABLE } from './analysis/pipeline';
import type { WhisperInstall } from './analysis/whisper';
import { AppDb, ProjectDb } from './db';
import { EditRequestError, EditSession, type SessionEvent } from './edit';
import type { JobQueue } from './jobs';
import {
  CUTROOM_DIR,
  cacheDir,
  cutroomDir,
  fromStoredPath,
  historyDir,
  indexDbPath,
  projectJsonPath,
  proxiesDir,
  toStoredPath,
} from './paths';
import { probeFile } from './probe';
import { generateAudioProxy, generatePoster, generateProxy, planAudioProxy, planProxy, proxyDimensions } from './proxy';
import { ProcessAbortedError } from './proc';
import { exists, fingerprintFile, mapLimit, renameRetry, writeJsonAtomic } from './util';

export interface ProjectManagerOptions {
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegStatus: () => FfmpegStatus;
  jobs: JobQueue;
  appDb: AppDb;
  /** Codec for newly generated video proxies (what this browser can decode). */
  proxyCodec: () => ProxyCodec;
  /** Debounce for autosave of project.json (spec: 1 s). */
  saveDelayMs?: number;
  probeConcurrency?: number;
  /** Where whisper.cpp lives, if anywhere. Default: look on PATH / env / the app data models folder. */
  whisper?: () => Promise<WhisperInstall | null>;
}

type Events = {
  media: [Media];
  mediaRemoved: [string];
  project: [ProjectSummary | null];
  scan: [ScanReport];
  session: [SessionEvent];
};

export { EditRequestError };

export class ProjectError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

type ImportOutcome =
  | { kind: 'imported' | 'changed' | 'unchanged' | 'relinked'; media: Media }
  | { kind: 'rejected'; reason: string };

const SKIP_DIRS = new Set(['node_modules', CUTROOM_DIR]);

export class ProjectManager extends EventEmitter<Events> {
  private project: Project | null = null;
  private folder: string | null = null;
  private db: ProjectDb | null = null;
  private session: EditSession | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private savePromise: Promise<void> = Promise.resolve();
  private readonly saveDelay: number;
  /** Serialises imports of the same path (scan + upload can race). */
  private readonly importing = new Map<string, Promise<ImportOutcome>>();

  /** Waveforms, loudness, scenes, transcript… queued as media becomes ready. */
  readonly analysis: MediaAnalysis;

  constructor(private readonly opts: ProjectManagerOptions) {
    super();
    this.analysis = new MediaAnalysis({
      jobs: opts.jobs,
      ffmpegPath: opts.ffmpegPath,
      cacheDir: (id) => cacheDir(this.requireProject().folder, id),
      abs: (stored) => fromStoredPath(this.requireProject().folder, stored),
      find: (id) => this.findMedia(id),
      patch: (id, fn) => this.patchMedia(id, fn),
      whisper: opts.whisper ?? (async () => null),
    });
    this.saveDelay = opts.saveDelayMs ?? 1000;
    opts.jobs.on('update', (j) => {
      if (!this.db || !['done', 'failed', 'canceled'].includes(j.state)) return;
      try {
        this.db.logJob({ id: j.id, kind: j.kind, mediaId: j.mediaId, state: j.state, startedAt: j.startedAt, finishedAt: j.finishedAt, error: j.error });
      } catch {
        /* the project may have been closed between the event and the write */
      }
    });
  }

  /* ------------------------------------------------------------------ state */

  get current(): Project | null {
    return this.project;
  }

  get projectFolder(): string | null {
    return this.folder;
  }

  requireProject(): { project: Project; folder: string } {
    if (!this.project || !this.folder) throw new ProjectError('no_project', 'No project is open.', 409);
    return { project: this.project, folder: this.folder };
  }

  summary(): ProjectSummary | null {
    if (!this.project || !this.folder) return null;
    return {
      id: this.project.id,
      name: this.project.name,
      folder: this.folder,
      settings: this.project.settings,
      mediaCount: this.project.media.length,
      ignoredCount: this.project.ignoredPaths?.length ?? 0,
    };
  }

  findMedia(id: string): Media | undefined {
    return this.project?.media.find((m) => m.id === id);
  }

  /** Absolute path of a cached analysis result (waveform, transcript…), or null if it is not ready. */
  analysisFile(media: Media, name: string): { file: string; type: string } | null {
    const entry = SERVABLE[name];
    if (!entry) return null;
    return { file: path.join(cacheDir(this.requireProject().folder, media.id), entry.file), type: entry.type };
  }

  mediaFile(media: Media, kind: 'original' | 'proxy' | 'audio' | 'poster'): string | null {
    if (!this.folder) return null;
    const stored = kind === 'original' ? media.path : kind === 'proxy' ? media.proxyPath : kind === 'audio' ? media.audioProxyPath : media.posterPath;
    return stored ? fromStoredPath(this.folder, stored) : null;
  }

  /* -------------------------------------------------------------- open/close */

  async open(folderInput: string): Promise<Project> {
    const folder = path.resolve(folderInput);
    let st;
    try {
      st = await fs.stat(folder);
    } catch {
      throw new ProjectError('not_found', `Folder not found: ${folder}`, 404);
    }
    if (!st.isDirectory()) throw new ProjectError('not_a_folder', `Not a folder: ${folder}`);
    await this.close();

    for (const dir of [cutroomDir(folder), proxiesDir(folder), cacheDir(folder), historyDir(folder)]) {
      await fs.mkdir(dir, { recursive: true });
    }
    this.folder = folder;
    this.db = new ProjectDb(indexDbPath(folder));
    this.project = await this.loadOrCreate(folder);
    this.opts.appDb.touchRecent(folder, this.project.name);
    this.emit('project', this.summary());

    await this.scan();
    this.initSession();
    return this.project;
  }

  async close(): Promise<void> {
    if (!this.project) return;
    for (const m of this.project.media) this.opts.jobs.cancelForMedia(m.id);
    await this.session?.flush();
    this.session = null;
    await this.flush();
    this.db?.close();
    this.db = null;
    this.project = null;
    this.folder = null;
    this.emit('project', null);
  }

  private async loadOrCreate(folder: string): Promise<Project> {
    const file = projectJsonPath(folder);
    let raw: string | null = null;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      /* new project */
    }
    if (raw === null) {
      const project: Project = {
        version: 1,
        id: randomUUID(),
        name: path.basename(folder) || folder,
        settings: { ...DEFAULT_PROJECT_SETTINGS },
        media: [],
        sequences: [],
        captionStyles: [],
        history: [],
      };
      await writeJsonAtomic(file, project);
      return project;
    }
    let parsed: Project;
    try {
      parsed = JSON.parse(raw) as Project;
    } catch (e) {
      throw new ProjectError('corrupt_project', `project.json is not valid JSON (${(e as Error).message}). It was left untouched.`, 422);
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.media)) {
      throw new ProjectError('unsupported_project', 'project.json has an unsupported format or version.', 422);
    }
    // A previous run may have died mid-job: anything "running" never finished.
    for (const m of parsed.media) {
      for (const k of Object.keys(m.status) as (keyof Media['status'])[]) if (m.status[k] === 'running' || m.status[k] === 'queued') m.status[k] = 'pending';
      m.missing = !(await exists(fromStoredPath(folder, m.path)));
    }
    return parsed;
  }

  /* -------------------------------------------------------------------- scan */

  async scan(opts: { includeIgnored?: boolean } = {}): Promise<ScanReport> {
    const { project, folder } = this.requireProject();
    if (opts.includeIgnored && project.ignoredPaths?.length) {
      project.ignoredPaths = [];
      this.emit('project', this.summary());
    }
    const ignored = new Set(project.ignoredPaths ?? []);
    const files = (await this.walk(folder)).filter((f) => !ignored.has(toStoredPath(folder, f)));
    const report: ScanReport = { imported: 0, changed: 0, unchanged: 0, missing: 0, relinked: 0, rejected: [] };

    // The first video (in path order) of an empty project defines its size and frame rate. Probing runs in parallel, so without
    // this the winner would be whichever file happened to finish first and the same folder could open as 16:9 or 9:16.
    const queue = [...files];
    const outcomes: { f: string; o: ImportOutcome }[] = [];
    while (queue.length && project.settings.auto && !project.media.some((m) => m.type === 'video')) {
      const f = queue.shift()!;
      outcomes.push({ f, o: await this.importFile(f) });
    }
    outcomes.push(...(await mapLimit(queue, this.opts.probeConcurrency ?? 4, async (f) => ({ f, o: await this.importFile(f) }))));
    for (const { f, o } of outcomes) {
      if (o.kind === 'rejected') report.rejected.push({ path: toStoredPath(folder, f), reason: o.reason });
      else report[o.kind]++;
    }

    const seen = new Set(files.map((f) => toStoredPath(folder, f)));
    for (const m of project.media) {
      const present = seen.has(m.path) || (path.isAbsolute(m.path) && (await exists(m.path)));
      if (!present && !m.missing) this.patchMedia(m.id, (x) => void (x.missing = true));
      if (!present) report.missing++;
    }
    this.scheduleSave();
    this.emit('scan', report);
    return report;
  }

  private async walk(root: string): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
          await visit(full);
        } else if ((e.isFile() || e.isSymbolicLink()) && !e.name.startsWith('.') && isSupportedExtension(e.name)) {
          out.push(full);
        }
      }
    };
    await visit(root);
    return out;
  }

  /* ------------------------------------------------------------------ import */

  importFile(abs: string): Promise<ImportOutcome> {
    const key = path.resolve(abs);
    const inflight = this.importing.get(key);
    if (inflight) return inflight;
    const p = this.doImport(key).finally(() => this.importing.delete(key));
    this.importing.set(key, p);
    return p;
  }

  private async doImport(abs: string): Promise<ImportOutcome> {
    const { project, folder } = this.requireProject();
    const db = this.db!;
    const stored = toStoredPath(folder, abs);

    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      return { kind: 'rejected', reason: 'File is not readable.' };
    }
    if (!st.isFile()) return { kind: 'rejected', reason: 'Not a regular file.' };

    const existing = project.media.find((m) => m.path === stored);
    if (existing && existing.sizeBytes === st.size && existing.mtimeMs === st.mtimeMs) {
      if (existing.missing) this.patchMedia(existing.id, (m) => void (m.missing = false));
      await this.ensureDerived(existing);
      return { kind: 'unchanged', media: existing };
    }

    const idx = db.getFile(stored);
    const fingerprint =
      idx && idx.size === st.size && idx.mtimeMs === st.mtimeMs ? idx.fingerprint : await fingerprintFile(abs, st.size);

    // Same path, different bytes: re-probe in place and throw away stale derived data.
    if (existing) {
      let probed;
      try {
        probed = await probeFile(abs, this.opts.ffprobePath);
      } catch (e) {
        return { kind: 'rejected', reason: (e as Error).message };
      }
      await this.discardDerived(existing);
      const media = this.patchMedia(existing.id, (m) => {
        Object.assign(m, probed, { sizeBytes: st.size, mtimeMs: st.mtimeMs, missing: false, status: emptyStatus(), analysis: {} });
        m.status.probe = 'done';
        delete m.proxy;
        delete m.proxyPath;
        delete m.audioProxyPath;
      })!;
      db.putFile({ path: stored, fingerprint, size: st.size, mtimeMs: st.mtimeMs, mediaId: media.id });
      await this.ensureDerived(media);
      return { kind: 'changed', media };
    }

    // Moved file: a media entry whose file vanished but whose content matches.
    let moved: Media | undefined;
    for (const row of db.findByFingerprint(fingerprint)) {
      if (!row.mediaId || row.path === stored) continue;
      const candidate = project.media.find((m) => m.id === row.mediaId);
      if (candidate && (candidate.missing || !(await exists(fromStoredPath(folder, candidate.path))))) {
        moved = candidate;
        break;
      }
    }
    if (moved) {
      const oldPath = moved.path;
      const media = this.patchMedia(moved.id, (m) => {
        m.path = stored;
        m.mtimeMs = st.mtimeMs;
        m.sizeBytes = st.size;
        m.missing = false;
      })!;
      db.removeFile(oldPath);
      db.putFile({ path: stored, fingerprint, size: st.size, mtimeMs: st.mtimeMs, mediaId: media.id });
      await this.ensureDerived(media);
      return { kind: 'relinked', media };
    }

    let probed;
    try {
      probed = await probeFile(abs, this.opts.ffprobePath);
    } catch (e) {
      return { kind: 'rejected', reason: (e as Error).message };
    }

    let id = `m_${fingerprint.slice(0, 12)}`;
    for (let n = 2; project.media.some((m) => m.id === id); n++) id = `m_${fingerprint.slice(0, 12)}_${n}`;

    const media: Media = {
      id,
      path: stored,
      type: probed.type,
      name: path.basename(abs),
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      duration: probed.duration,
      fps: probed.fps,
      audioChannels: probed.audioChannels,
      video: probed.video,
      audio: probed.audio,
      container: probed.container,
      status: emptyStatus(),
      missing: false,
      warnings: probed.warnings,
      analysis: {},
      importedAt: new Date().toISOString(),
    };
    media.status.probe = 'done';

    if (media.type === 'video' && media.video && project.settings.auto && !project.media.some((m) => m.type === 'video')) {
      const { width, height } = proxyDimensions(media.video.width, media.video.height);
      project.settings = { ...project.settings, width, height, fps: media.video.fps, auto: false };
      this.rebuildEmptySequence();
      this.emit('project', this.summary());
    }

    project.media.push(media);
    db.putFile({ path: stored, fingerprint, size: st.size, mtimeMs: st.mtimeMs, mediaId: id });
    this.scheduleSave();
    this.emit('media', media);
    await this.ensureDerived(media);
    return { kind: 'imported', media };
  }

  /* ------------------------------------------------------- derived assets */

  /** Queue poster/proxy jobs for whatever is missing on disk — or was made for a codec this browser cannot decode. */
  private async ensureDerived(media: Media): Promise<void> {
    const { folder } = this.requireProject();
    if (media.missing) return;
    const codec = this.opts.proxyCodec();

    const gone = async (stored?: string) => !!stored && !(await exists(fromStoredPath(folder, stored)));
    const wantsAudioProxy = !!media.audio;
    const stale =
      media.status.proxy === 'done' &&
      ((media.type === 'video' && media.proxy?.codec !== codec) || (wantsAudioProxy && !media.audioProxyPath));
    if (stale || (await gone(media.proxyPath)) || (await gone(media.audioProxyPath))) {
      this.patchMedia(media.id, (m) => {
        delete m.proxyPath;
        delete m.audioProxyPath;
        delete m.proxy;
        m.status.proxy = 'pending';
      });
    }
    if (await gone(media.posterPath)) {
      this.patchMedia(media.id, (m) => {
        delete m.posterPath;
        m.status.poster = 'pending';
      });
    }

    const m = this.findMedia(media.id)!;
    if (m.type === 'audio') this.patchMedia(m.id, (x) => void (x.status.poster = 'skipped'));
    if (m.type === 'image' && m.status.proxy !== 'skipped') this.patchMedia(m.id, (x) => void (x.status.proxy = 'skipped'));
    if (m.status.poster === 'pending') this.queuePoster(m.id);
    if (m.type !== 'image' && m.status.proxy === 'pending') this.queueProxy(m.id);
    await this.analysis.ensure(m.id).catch(() => undefined); // waits for the proxy by itself: ensure() is re-run when it lands
  }

  /** The browser's decoding abilities changed: regenerate every proxy that was made for another codec. */
  async refreshProxies(): Promise<number> {
    const { project } = this.requireProject();
    let n = 0;
    for (const m of project.media) {
      if (m.type === 'video' && m.status.proxy === 'done' && m.proxy?.codec !== this.opts.proxyCodec()) {
        await this.reproxy(m.id);
        n++;
      }
    }
    return n;
  }

  private queuePoster(id: string): void {
    this.patchMedia(id, (m) => void (m.status.poster = 'queued'));
    this.opts.jobs.add({
      kind: 'poster',
      label: `Thumbnail · ${this.findMedia(id)?.name ?? id}`,
      mediaId: id,
      run: async ({ signal }) => {
        const m = this.findMedia(id);
        const { folder } = this.requireProject();
        if (!m) return;
        this.patchMedia(id, (x) => void (x.status.poster = 'running'));
        const out = path.join(cacheDir(folder, id), 'poster.jpg');
        try {
          await fs.mkdir(path.dirname(out), { recursive: true });
          await generatePoster(fromStoredPath(folder, m.path), out, m, { ffmpegPath: this.opts.ffmpegPath, signal });
          this.patchMedia(id, (x) => {
            x.posterPath = toStoredPath(folder, out);
            x.status.poster = 'done';
          });
        } catch (e) {
          this.patchMedia(id, (x) => void (x.status.poster = e instanceof ProcessAbortedError ? 'pending' : 'failed'));
          throw e;
        }
      },
    });
  }

  private queueProxy(id: string): void {
    this.patchMedia(id, (m) => void (m.status.proxy = 'queued'));
    this.opts.jobs.add({
      kind: 'proxy',
      label: `Proxy · ${this.findMedia(id)?.name ?? id}`,
      mediaId: id,
      priority: true,
      run: async ({ signal, progress }) => {
        const m = this.findMedia(id);
        const { folder } = this.requireProject();
        if (!m || (!m.video && !m.audio)) return;
        this.patchMedia(id, (x) => void (x.status.proxy = 'running'));
        const duration = toNumber(m.duration);
        const base = { ffmpegPath: this.opts.ffmpegPath, signal };
        const codec = this.opts.proxyCodec();
        const videoShare = m.video ? (m.audio ? 0.85 : 1) : 0;
        try {
          const videoOut = m.video ? path.join(proxiesDir(folder), `${id}.mp4`) : undefined;
          const audioOut = m.audio ? path.join(proxiesDir(folder), `${id}.wav`) : undefined;
          const plan = m.video ? planProxy(m.video, this.opts.ffmpegStatus(), codec) : undefined;
          // the picture and the sound are separate files, so they are made side by side; the sound finishes first
          let vp = 0;
          let ap = 0;
          const report = () => progress(vp * videoShare + ap * (1 - videoShare));
          // if one of them fails the other is stopped instead of left running
          const both = new AbortController();
          const stop = () => both.abort();
          signal.addEventListener('abort', stop, { once: true });
          const opts = { ffmpegPath: base.ffmpegPath, signal: both.signal };
          try {
            await Promise.all([
              videoOut && plan ? generateProxy(fromStoredPath(folder, m.path), videoOut, plan, duration, { ...opts, onProgress: (p) => ((vp = p), report()) }).catch((e) => (stop(), Promise.reject(e))) : undefined,
              audioOut ? generateAudioProxy(fromStoredPath(folder, m.path), audioOut, planAudioProxy(m.audio!, m.video), duration, { ...opts, onProgress: (p) => ((ap = p), report()) }).catch((e) => (stop(), Promise.reject(e))) : undefined,
            ]);
          } finally {
            signal.removeEventListener('abort', stop);
          }
          this.patchMedia(id, (x) => {
            if (videoOut && plan) {
              x.proxyPath = toStoredPath(folder, videoOut);
              x.proxy = { width: plan.width, height: plan.height, fps: plan.fps, codec: plan.codec };
              for (const w of plan.warnings) if (!x.warnings.includes(w)) x.warnings.push(w);
            }
            if (audioOut) x.audioProxyPath = toStoredPath(folder, audioOut);
            x.status.proxy = 'done';
          });
          void this.analysis.ensure(id).catch(() => undefined);
        } catch (e) {
          const aborted = e instanceof ProcessAbortedError;
          if (!aborted) console.error(`[proxy] ${m.name}: ${(e as Error).message}`);
          this.patchMedia(id, (x) => {
            x.status.proxy = aborted ? 'pending' : 'failed';
            if (!aborted) x.warnings.push(`Proxy generation failed: ${(e as Error).message}`);
          });
          throw e;
        }
      },
    });
  }

  private async discardDerived(media: Media): Promise<void> {
    const { folder } = this.requireProject();
    this.opts.jobs.cancelForMedia(media.id);
    if (media.proxyPath) await fs.rm(fromStoredPath(folder, media.proxyPath), { force: true });
    if (media.audioProxyPath) await fs.rm(fromStoredPath(folder, media.audioProxyPath), { force: true });
    await fs.rm(cacheDir(folder, media.id), { recursive: true, force: true });
  }

  /** Regenerate the proxy even if one exists. */
  async reproxy(id: string): Promise<Media> {
    const m = this.findMedia(id);
    if (!m) throw new ProjectError('no_such_media', `No media with id ${id}.`, 404);
    if (m.type === 'image') throw new ProjectError('not_video', 'Still images do not have a proxy.');
    if (m.missing) throw new ProjectError('media_missing', 'The source file is missing; relink it first.', 409);
    const { folder } = this.requireProject();
    this.opts.jobs.cancelForMedia(id);
    if (m.proxyPath) await fs.rm(fromStoredPath(folder, m.proxyPath), { force: true });
    if (m.audioProxyPath) await fs.rm(fromStoredPath(folder, m.audioProxyPath), { force: true });
    const updated = this.patchMedia(id, (x) => {
      delete x.proxyPath;
      delete x.audioProxyPath;
      delete x.proxy;
      x.status.proxy = 'pending';
    })!;
    this.queueProxy(id);
    return this.findMedia(updated.id)!;
  }

  /* ------------------------------------------------------------- mutations */

  /** Mutate a media record in place, then persist (debounced) and notify listeners. */
  patchMedia(id: string, mutate: (m: Media) => void): Media | undefined {
    const m = this.findMedia(id);
    if (!m) return undefined;
    mutate(m);
    this.scheduleSave();
    this.emit('media', m);
    return m;
  }

  async removeMedia(id: string): Promise<void> {
    const { project } = this.requireProject();
    const m = this.findMedia(id);
    if (!m) throw new ProjectError('no_such_media', `No media with id ${id}.`, 404);
    const used = this.clipsUsing(id);
    if (used > 0) throw new ProjectError('media_in_use', `${m.name} is used by ${used} clip${used === 1 ? '' : 's'} on the timeline. Delete those first.`, 409, { clips: used });
    await this.discardDerived(m);
    // Remember the removal, otherwise the next scan would just import the file again.
    const ignored = (project.ignoredPaths ??= []);
    if (!ignored.includes(m.path)) ignored.push(m.path);
    project.media = project.media.filter((x) => x.id !== id);
    this.scheduleSave();
    this.emit('mediaRemoved', id);
    this.emit('project', this.summary());
  }

  /** Point a missing (or any) media entry at a new file. Refuses obvious mismatches unless forced. */
  async relink(id: string, newPath: string, force = false): Promise<Media> {
    const { folder } = this.requireProject();
    const m = this.findMedia(id);
    if (!m) throw new ProjectError('no_such_media', `No media with id ${id}.`, 404);
    const abs = path.resolve(newPath);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new ProjectError('not_found', `File not found: ${abs}`, 404);
    }
    if (!st.isFile() || !isSupportedExtension(abs)) throw new ProjectError('unsupported', 'That is not a supported media file.');
    const probed = await probeFile(abs, this.opts.ffprobePath).catch((e: Error) => {
      throw new ProjectError('probe_failed', e.message, 422);
    });
    const durationDelta = Math.abs(toNumber(probed.duration) - toNumber(m.duration));
    const mismatch =
      probed.type !== m.type
        ? `Type differs (${m.type} → ${probed.type}).`
        : durationDelta > 0.25
          ? `Duration differs by ${durationDelta.toFixed(2)} s.`
          : null;
    if (mismatch && !force) throw new ProjectError('relink_mismatch', mismatch, 409, { mismatch });

    const fingerprint = await fingerprintFile(abs, st.size);
    const sameContent = this.db!.findByFingerprint(fingerprint).some((r) => r.mediaId === id) || (st.size === m.sizeBytes && st.mtimeMs === m.mtimeMs);
    if (!sameContent) await this.discardDerived(m);
    const stored = toStoredPath(folder, abs);
    const media = this.patchMedia(id, (x) => {
      x.path = stored;
      x.sizeBytes = st.size;
      x.mtimeMs = st.mtimeMs;
      x.missing = false;
      if (!sameContent) {
        Object.assign(x, probed, { status: emptyStatus(), analysis: {} });
        x.status.probe = 'done';
        delete x.proxy;
        delete x.proxyPath;
        delete x.audioProxyPath;
        delete x.posterPath;
      }
    })!;
    this.db!.putFile({ path: stored, fingerprint, size: st.size, mtimeMs: st.mtimeMs, mediaId: id });
    await this.ensureDerived(media);
    return media;
  }

  /** An explicit import of a previously removed file brings it back. */
  clearIgnored(absPath: string): void {
    const { project, folder } = this.requireProject();
    const stored = toStoredPath(folder, path.resolve(absPath));
    if (project.ignoredPaths?.includes(stored)) {
      project.ignoredPaths = project.ignoredPaths.filter((p) => p !== stored);
      this.emit('project', this.summary());
    }
  }

  /** Files in the project folder with the same name as a missing media entry — relink suggestions. */
  async relinkCandidates(id: string): Promise<string[]> {
    const { folder } = this.requireProject();
    const m = this.findMedia(id);
    if (!m) throw new ProjectError('no_such_media', `No media with id ${id}.`, 404);
    const files = await this.walk(folder);
    return files.filter((f) => path.basename(f).toLowerCase() === m.name.toLowerCase()).map((f) => toStoredPath(folder, f));
  }

  updateSettings(patch: Partial<Omit<ProjectSettings, 'sampleRate'>>): ProjectSettings {
    const { project } = this.requireProject();
    const next = { ...project.settings, ...patch, auto: false };
    if (!Number.isInteger(next.width) || !Number.isInteger(next.height) || next.width < 16 || next.height < 16) {
      throw new ProjectError('bad_settings', 'Width and height must be integers ≥ 16.');
    }
    if (!Number.isInteger(next.fps.num) || !Number.isInteger(next.fps.den) || next.fps.num <= 0 || next.fps.den <= 0) {
      throw new ProjectError('bad_settings', 'Frame rate must be a positive rational.');
    }
    const fpsChanged = next.fps.num * project.settings.fps.den !== project.settings.fps.num * next.fps.den;
    if (fpsChanged && !this.sequenceIsEmpty()) {
      throw new ProjectError('sequence_not_empty', 'The frame rate cannot change while the timeline has clips: every edit is frame-aligned to it.', 409);
    }
    project.settings = next;
    if (fpsChanged) this.rebuildEmptySequence();
    else if (this.session && (next.width !== this.session.state.width || next.height !== this.session.state.height)) {
      this.session.edit({ ops: [{ type: 'setSequenceProps', patch: { width: next.width, height: next.height } }], label: 'Change sequence size' });
    }
    this.scheduleSave();
    this.emit('project', this.summary());
    return next;
  }

  /* ----------------------------------------------------------------- editing */

  private newSequence(): Sequence {
    const { settings } = this.project!;
    return createSequence({ width: settings.width, height: settings.height, fps: settings.fps, sampleRate: settings.sampleRate });
  }

  private initSession(): void {
    const { project, folder } = this.requireProject();
    const seq = project.sequences[0] ?? this.newSequence();
    project.sequences = [seq];
    this.session = new EditSession(seq, (id) => this.findMedia(id), historyDir(folder), (e) => {
      if (e.type === 'sequence') {
        project.sequences[0] = this.session!.state;
        this.scheduleSave();
      }
      this.emit('session', e);
    });
  }

  /** The editing session of the open project. */
  requireSession(): EditSession {
    this.requireProject();
    if (!this.session) throw new ProjectError('no_session', 'The project is still opening.', 409);
    return this.session;
  }

  get revision(): number {
    return this.session?.editor.revision ?? 0;
  }

  historyState(): HistoryState {
    return this.session?.history() ?? { canUndo: false, canRedo: false, undo: [], redo: [], snapshots: [] };
  }

  edit(req: EditRequest): EditResponse {
    return this.requireSession().edit(req);
  }

  /** Number of clips that use `mediaId`. */
  clipsUsing(mediaId: string): number {
    const seq = this.project?.sequences[0];
    return seq ? seq.tracks.reduce((n, t) => n + Object.values(t.items).filter((i) => i.kind === 'clip' && i.mediaId === mediaId).length, 0) : 0;
  }

  private sequenceIsEmpty(): boolean {
    return !this.project?.sequences[0]?.tracks.some((t) => Object.keys(t.items).length > 0);
  }

  /** The first imported video fixed the project settings: an empty sequence must follow them. */
  private rebuildEmptySequence(): void {
    if (!this.session || !this.sequenceIsEmpty()) return;
    this.session.editor.load(this.newSequence());
    this.project!.sequences = [this.session.state];
  }

  /* ----------------------------------------------------------------- saving */

  scheduleSave(): void {
    if (!this.project) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writeNow();
    }, this.saveDelay);
    this.saveTimer.unref?.();
  }

  /** Cancel the debounce and write immediately; resolves when the file is on disk. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.writeNow();
    }
    await this.savePromise;
  }

  private writeNow(): Promise<void> {
    if (!this.project || !this.folder) return this.savePromise;
    const file = projectJsonPath(this.folder);
    const snapshot = JSON.stringify(this.project, null, 2);
    // Serialise writes so a slow disk can never apply two saves out of order.
    this.savePromise = this.savePromise
      .then(async () => {
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, snapshot);
        await renameRetry(tmp, file);
      })
      .catch((e) => console.error('[project] autosave failed:', e));
    return this.savePromise;
  }
}
