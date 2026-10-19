import { create } from 'zustand';
import { type Sequence, frameTicks } from '@cutroom/core';
import { type View, clampView, contentHeight, fitView, trackRows, zoomAt } from '../timeline/geometry';
import { sequenceDuration } from '@cutroom/core';

export type Tool = 'select' | 'blade' | 'forward';

export interface StatusMessage {
  text: string;
  kind: 'error' | 'info';
  at: number;
}

interface TimelineState {
  /** Sequence ticks. Always on the frame grid. */
  playhead: number;
  playing: boolean;
  /** Shuttle speed: 1 = normal, 2/4/8 = fast forward, negatives reverse (J). */
  shuttle: number;
  inPoint: number | null;
  outPoint: number | null;
  loop: boolean;
  tool: Tool;
  snapping: boolean;
  linkedSelection: boolean;
  selection: ReadonlySet<string>;
  view: View;
  status: StatusMessage | null;

  setPlayhead(ticks: number, seq: Sequence | null): void;
  stepFrames(n: number, seq: Sequence | null): void;
  setPlaying(p: boolean): void;
  setShuttle(s: number): void;
  setIn(t: number | null): void;
  setOut(t: number | null): void;
  toggleLoop(): void;
  setTool(t: Tool): void;
  toggleSnapping(): void;
  toggleLinked(): void;
  select(ids: readonly string[], mode?: 'replace' | 'add' | 'toggle'): void;
  clearSelection(): void;
  setView(v: Partial<View>, seq: Sequence | null): void;
  zoom(factor: number, focusX: number, seq: Sequence | null): void;
  fit(seq: Sequence | null): void;
  say(text: string, kind?: StatusMessage['kind']): void;
}

export const DEFAULT_VIEW: View = { pps: 60, scrollX: 0, scrollY: 0, width: 800, height: 240 };

const clampFor = (v: View, seq: Sequence | null): View =>
  seq ? clampView(v, Math.max(sequenceDuration(seq), seq.timebase.rate * 10), seq.timebase.rate, contentHeight(trackRows(seq))) : v;

export const useTimeline = create<TimelineState>()((set, get) => ({
  playhead: 0,
  playing: false,
  shuttle: 1,
  inPoint: null,
  outPoint: null,
  loop: false,
  tool: 'select',
  snapping: true,
  linkedSelection: true,
  selection: new Set(),
  view: DEFAULT_VIEW,
  status: null,

  setPlayhead(ticks, seq) {
    const f = seq ? frameTicks(seq.timebase) : 1;
    set({ playhead: Math.max(0, Math.round(ticks / f) * f) });
  },
  stepFrames(n, seq) {
    if (!seq) return;
    get().setPlayhead(get().playhead + n * frameTicks(seq.timebase), seq);
  },
  setPlaying: (playing) => set({ playing, ...(playing ? {} : { shuttle: 1 }) }),
  setShuttle: (shuttle) => set({ shuttle }),
  setIn: (inPoint) => set({ inPoint }),
  setOut: (outPoint) => set({ outPoint }),
  toggleLoop: () => set((s) => ({ loop: !s.loop })),
  setTool: (tool) => set({ tool }),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
  toggleLinked: () => set((s) => ({ linkedSelection: !s.linkedSelection })),

  select(ids, mode = 'replace') {
    const cur = new Set(mode === 'replace' ? [] : get().selection);
    for (const id of ids) {
      if (mode === 'toggle' && cur.has(id)) cur.delete(id);
      else cur.add(id);
    }
    set({ selection: cur });
  },
  clearSelection: () => set((s) => (s.selection.size ? { selection: new Set() } : {})),

  setView: (v, seq) => set((s) => ({ view: clampFor({ ...s.view, ...v }, seq) })),
  zoom: (factor, focusX, seq) => set((s) => ({ view: clampFor(zoomAt(s.view, focusX, factor), seq) })),
  fit: (seq) => set((s) => ({ view: seq ? clampFor(fitView(seq, Math.max(sequenceDuration(seq), seq.timebase.rate * 10), s.view), seq) : s.view })),

  say(text, kind = 'info') {
    const at = Date.now();
    set({ status: { text, kind, at } });
    setTimeout(() => {
      if (get().status?.at === at) set({ status: null });
    }, kind === 'error' ? 6000 : 3000);
  },
}));
