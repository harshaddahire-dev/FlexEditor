import { create } from 'zustand';
import { type CaptionExport, type ExportInfo, type ExportRequest, exportPreset, exportRange, frameTicks, isCaption, sequenceDuration, trackItems } from '@cutroom/core';
import { ExportCanceled, chooseEngine, runExport } from '../export/exporter';
import { useApp } from './app';
import { useTimeline } from './timeline';

export type EngineChoice = 'auto' | 'webcodecs' | 'ffmpeg';

interface ExportState {
  open: boolean;
  preset: string;
  name: string;
  captions: CaptionExport;
  range: 'all' | 'inout';
  half: boolean;
  draft: boolean;
  engine: EngineChoice;

  running: boolean;
  progress: number;
  label: string;
  /** Which engine the last run used, and why not the browser one when it fell back. */
  used: { engine: 'webcodecs' | 'ffmpeg'; reason?: string } | null;
  info: ExportInfo | null;
  error: string | null;
  abort: AbortController | null;

  openDialog(): void;
  close(): void;
  patch(p: Partial<Pick<ExportState, 'preset' | 'name' | 'captions' | 'range' | 'half' | 'draft' | 'engine'>>): void;
  start(): Promise<void>;
  cancel(): void;
  /** Back to the form after a finished or failed run. */
  reset(): void;
}

export const hasCaptions = (): boolean => !!useApp.getState().sequence?.tracks.some((t) => t.kind === 'caption' && trackItems(t).some(isCaption));

export const useExport = create<ExportState>()((set, get) => ({
  open: false,
  preset: 'h264-mp4',
  name: '',
  captions: 'none',
  range: 'all',
  half: false,
  draft: false,
  engine: 'auto',
  running: false,
  progress: 0,
  label: '',
  used: null,
  info: null,
  error: null,
  abort: null,

  openDialog: () => {
    const { project } = useApp.getState();
    const s = get();
    if (s.running) return set({ open: true });
    set({ open: true, info: null, error: null, name: s.name || (project?.name ?? 'export').replace(/\s+/g, '-'), captions: hasCaptions() ? (s.captions === 'none' ? 'burn' : s.captions) : 'none', range: s.range === 'inout' && useTimeline.getState().inPoint !== null ? 'inout' : 'all' });
  },
  close: () => set({ open: false }),
  patch: (p) => set(p),
  reset: () => set({ info: null, error: null, progress: 0, label: '', used: null }),

  cancel: () => get().abort?.abort(),

  async start() {
    const { sequence: seq, media } = useApp.getState();
    const s = get();
    if (!seq || s.running) return;
    const preset = exportPreset(s.preset);
    if (!preset) return;
    const tl = useTimeline.getState();
    const dur = sequenceDuration(seq);
    const step = frameTicks(seq.timebase);
    const marked = s.range === 'inout' ? exportRange(dur, { from: tl.inPoint ?? 0, to: tl.outPoint ?? dur }) : { from: 0, to: dur };
    const from = Math.round(marked.from / step) * step;
    const to = Math.round(marked.to / step) * step;
    if (to <= from) return set({ error: 'There is nothing to export: the timeline is empty or the range has no length.' });

    const abort = new AbortController();
    set({ running: true, progress: 0, label: 'Preparing', info: null, error: null, used: null, abort });
    try {
      const choice = s.engine === 'auto' ? await chooseEngine(preset, seq, media, s.draft) : { engine: s.engine, ...(s.engine === 'ffmpeg' ? {} : { reason: undefined }) };
      set({ used: choice });
      const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
      const req: ExportRequest = {
        preset: s.preset,
        name: s.name.trim() || 'export',
        engine: preset.video ? choice.engine : 'ffmpeg',
        captions: s.captions,
        ...(s.half ? { width: even(seq.width / 2), height: even(seq.height / 2) } : {}),
        ...(s.draft && choice.engine === 'webcodecs' ? { draft: true } : {}),
      };
      const info = await runExport(req, seq, media, from, to, abort.signal, {
        onInfo: (i) => set({ info: i }),
        onProgress: (progress, label) => set({ progress, label }),
      });
      set({ info, running: false, abort: null, progress: 1, label: 'Done' });
    } catch (e) {
      set({ running: false, abort: null, error: e instanceof ExportCanceled ? 'Export canceled.' : e instanceof Error ? e.message : String(e) });
    }
  },
}));
