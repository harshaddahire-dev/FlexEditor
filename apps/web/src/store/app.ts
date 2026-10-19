import { create } from 'zustand';
import type { HealthResponse, JobInfo, Media, ProjectResponse, RecentProject, ScanReport } from '@cutroom/core';
import { ApiError, api, uploadFile } from '../lib/api';
import type { PendingUpload } from '../lib/dropped';
import { connectSocket, type SocketHandle } from '../lib/ws';
import { probeProxyCodec } from '../playback/videoSource';
import { useAgent } from './agent';
import { applyServerEvent, type LiveState } from './events';

export interface UploadItem {
  id: string;
  name: string;
  loaded: number;
  total: number;
  state: 'queued' | 'uploading' | 'done' | 'failed';
  error?: string;
}

interface AppState extends LiveState {
  booting: boolean;
  /** Set when the server cannot be reached at all. */
  fatal: string | null;
  health: HealthResponse | null;
  recent: RecentProject[];
  wsConnected: boolean;
  /** Bumped on every bin click, even on the already-selected item — the Viewer shows Source for it. */
  picks: number;
  uploads: UploadItem[];
  opening: boolean;
  openError: string | null;

  boot(): Promise<void>;
  recheckFfmpeg(): Promise<void>;
  openProject(path: string): Promise<boolean>;
  closeProject(): Promise<void>;
  rescan(includeIgnored?: boolean): Promise<ScanReport | null>;
  uploadFiles(items: PendingUpload[]): Promise<void>;
  dismissUpload(id: string): void;
  selectMedia(id: string | null): void;
  removeMedia(id: string): Promise<void>;
  reproxy(id: string): Promise<void>;
  relink(id: string, path: string, force?: boolean): Promise<Media>;
  cancelJob(id: string): Promise<void>;
  forgetRecent(path: string): Promise<void>;
  setProjectFromResponse(r: ProjectResponse): void;
  refreshSequence(): Promise<void>;
  edit(ops: unknown[], label?: string): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

let socket: SocketHandle | null = null;
let uploadSeq = 0;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const useApp = create<AppState>()((set, get) => {
  const syncProject = async () => {
    try {
      const health = await api.health();
      set({ health });
      if (health.hasProject) get().setProjectFromResponse(await api.getProject());
      else set({ project: null, media: {} });
    } catch {
      /* the socket will retry; boot() reports hard failures */
    }
  };

  return {
    booting: true,
    fatal: null,
    health: null,
    recent: [],
    wsConnected: false,
    picks: 0,
    project: null,
    media: {},
    jobs: {},
    selectedMediaId: null,
    lastScan: null,
    sequence: null,
    revision: 0,
    sequenceStale: false,
    history: null,
    uploads: [],
    opening: false,
    openError: null,

    async boot() {
      try {
        const health = await api.health();
        set({ health, fatal: null });
        // Proxies must be in a format this browser can decode; tell the server before any project loads.
        await probeProxyCodec().then((codec) => api.setProxyCodec(codec)).catch(() => undefined);
        const [recent] = await Promise.all([api.recent().catch(() => []), health.hasProject ? api.getProject().then((r) => get().setProjectFromResponse(r)) : null]);
        set({ recent });
      } catch (e) {
        set({ fatal: message(e) });
      } finally {
        set({ booting: false });
      }
      socket ??= connectSocket(
        (ev) => {
          if (ev.type === 'agent') return useAgent.getState().onServerEvent(ev);
          set((s) => applyServerEvent(s, ev));
          // missed a patch: fetch the authoritative sequence again
          if (get().sequenceStale) void get().refreshSequence();
        },
        (connected) => {
          const was = get().wsConnected;
          set({ wsConnected: connected });
          if (connected && !was && !get().booting) void syncProject();
        },
      );
    },

    async recheckFfmpeg() {
      const ffmpeg = await api.recheckFfmpeg();
      set((s) => (s.health ? { health: { ...s.health, ffmpeg } } : {}));
    },

    setProjectFromResponse(r) {
      set({
        project: r.summary,
        media: Object.fromEntries(r.project.media.map((m) => [m.id, m])),
        sequence: r.project.sequences[0] ?? null,
        revision: r.revision,
        sequenceStale: false,
        history: r.history,
      });
    },

    async openProject(path) {
      set({ opening: true, openError: null });
      try {
        get().setProjectFromResponse(await api.openProject(path));
        set({ selectedMediaId: null, recent: await api.recent().catch(() => get().recent) });
        return true;
      } catch (e) {
        set({ openError: message(e) });
        return false;
      } finally {
        set({ opening: false });
      }
    },

    async closeProject() {
      await api.closeProject();
      set({ project: null, media: {}, selectedMediaId: null, lastScan: null, recent: await api.recent().catch(() => get().recent) });
    },

    async rescan(includeIgnored = false) {
      try {
        const report = await api.rescan(includeIgnored);
        set({ lastScan: report });
        return report;
      } catch (e) {
        set({ openError: message(e) });
        return null;
      }
    },

    async uploadFiles(items) {
      const queued: UploadItem[] = items.map((i) => ({ id: `u${++uploadSeq}`, name: i.rel, loaded: 0, total: i.file.size, state: 'queued' }));
      set((s) => ({ uploads: [...s.uploads, ...queued] }));
      const patch = (id: string, p: Partial<UploadItem>) =>
        set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...p } : u)) }));

      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          const item = items[i];
          const up = queued[i];
          if (!item || !up) return;
          patch(up.id, { state: 'uploading' });
          try {
            await uploadFile(item.file, item.rel, (loaded, total) => patch(up.id, { loaded, total }));
            patch(up.id, { state: 'done', loaded: item.file.size });
            setTimeout(() => get().dismissUpload(up.id), 2500);
          } catch (e) {
            patch(up.id, { state: 'failed', error: e instanceof ApiError ? e.message : message(e) });
          }
        }
      };
      await Promise.all([worker(), worker()]);
    },

    dismissUpload(id) {
      set((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
    },

    selectMedia(id) {
      set((s) => ({ selectedMediaId: id, picks: s.picks + 1 }));
    },

    async removeMedia(id) {
      await api.removeMedia(id);
    },

    async reproxy(id) {
      await api.reproxy(id);
    },

    async relink(id, path, force) {
      return api.relink(id, path, force);
    },

    async cancelJob(id) {
      await api.cancelJob(id);
    },

    async refreshSequence() {
      try {
        const r = await api.getSequence();
        set({ sequence: r.sequence, revision: r.revision, sequenceStale: false, history: r.history });
      } catch {
        /* closed project or lost connection: the next hello/sync repairs it */
      }
    },

    async edit(ops, label) {
      await api.edit({ ops, label });
    },
    async undo() {
      await api.undo();
    },
    async redo() {
      await api.redo();
    },

    async forgetRecent(path) {
      await api.forgetRecent(path);
      set({ recent: await api.recent().catch(() => get().recent) });
    },
  };
});

export const jobsForMedia = (jobs: Record<string, JobInfo>, mediaId: string): JobInfo[] =>
  Object.values(jobs).filter((j) => j.mediaId === mediaId && (j.state === 'queued' || j.state === 'running'));
