import { type Op, sequenceDuration } from '@cutroom/core';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';
import { useUi } from '../store/ui';
import {
  CommandError, addMarkerAt, deleteItems, editPoints, expandLinked, placeMedia, rippleTrimToPlayhead, splitAtPlayhead,
} from '../timeline/commands';
import { dryRun, makeEnv } from './env';

export interface Action {
  id: string;
  label: string;
  /** Keyboard shortcut(s) in `Mod+Shift+Z` form; Mod = ⌘ on macOS, Ctrl elsewhere. */
  keys: string[];
  group: 'Playback' | 'Edit' | 'Timeline' | 'Tools' | 'View' | 'App';
  run(): void | Promise<void>;
}

const tl = () => useTimeline.getState();
const app = () => useApp.getState();

/** Send ops to the server as one transaction; report a rejection on the timeline status line. */
export async function dispatch(ops: Op[], label?: string): Promise<boolean> {
  try {
    await app().edit(ops, label);
    return true;
  } catch (e) {
    tl().say(e instanceof Error ? e.message : String(e), 'error');
    return false;
  }
}

/** Build ops from a command (which may throw CommandError) and send them. */
async function command(build: () => Op[], label?: string): Promise<void> {
  try {
    const ops = build();
    const { sequence, media } = app();
    if (sequence) {
      const why = dryRun(sequence, ops, makeEnv(media, sequence));
      if (why) return tl().say(why, 'error');
    }
    await dispatch(ops, label);
  } catch (e) {
    if (e instanceof CommandError) tl().say(e.message, 'error');
    else throw e;
  }
}

const seq = () => app().sequence;

function jump(dir: 1 | -1): void {
  const s = seq();
  if (!s) return;
  const pts = editPoints(s);
  const p = tl().playhead;
  const target = dir > 0 ? pts.find((x) => x > p) : [...pts].reverse().find((x) => x < p);
  if (target !== undefined) tl().setPlayhead(target, s);
}

function selectedOrAll(): string[] {
  const s = seq();
  return s ? Object.values(s.tracks).flatMap((t) => Object.keys(t.items)) : [];
}

/** Place the selected media-bin item(s) at the playhead. */
export function placeSelectedMedia(mode: 'insert' | 'overwrite'): void {
  const { sequence, media, selectedMediaId } = app();
  if (!sequence || !selectedMediaId || !media[selectedMediaId]) return tl().say('Select media in the bin first.', 'error');
  void command(() => placeMedia(sequence, [media[selectedMediaId]!], tl().playhead, mode), mode === 'insert' ? 'Insert clip' : 'Overwrite with clip');
}

export const ACTIONS: Action[] = [
  { id: 'play', label: 'Play / pause', keys: ['Space'], group: 'Playback', run: () => tl().setPlaying(!tl().playing) },
  { id: 'shuttle.back', label: 'Shuttle reverse (J)', keys: ['j'], group: 'Playback', run: () => { const t = tl(); const next = t.playing && t.shuttle < 0 ? Math.max(-8, t.shuttle * 2) : -1; t.setShuttle(next); t.setPlaying(true); } },
  { id: 'shuttle.stop', label: 'Stop (K)', keys: ['k'], group: 'Playback', run: () => tl().setPlaying(false) },
  { id: 'shuttle.fwd', label: 'Shuttle forward (L)', keys: ['l'], group: 'Playback', run: () => { const t = tl(); const next = t.playing && t.shuttle > 0 ? Math.min(8, t.shuttle * 2) : 1; t.setShuttle(next); t.setPlaying(true); } },
  { id: 'step.back', label: 'Back one frame', keys: ['ArrowLeft'], group: 'Playback', run: () => tl().stepFrames(-1, seq()) },
  { id: 'step.fwd', label: 'Forward one frame', keys: ['ArrowRight'], group: 'Playback', run: () => tl().stepFrames(1, seq()) },
  { id: 'step.back10', label: 'Back ten frames', keys: ['Shift+ArrowLeft'], group: 'Playback', run: () => tl().stepFrames(-10, seq()) },
  { id: 'step.fwd10', label: 'Forward ten frames', keys: ['Shift+ArrowRight'], group: 'Playback', run: () => tl().stepFrames(10, seq()) },
  { id: 'goto.start', label: 'Go to start', keys: ['Home'], group: 'Playback', run: () => tl().setPlayhead(0, seq()) },
  { id: 'goto.end', label: 'Go to end', keys: ['End'], group: 'Playback', run: () => { const s = seq(); if (s) tl().setPlayhead(sequenceDuration(s), s); } },
  { id: 'edit.prev', label: 'Previous edit point', keys: ['ArrowUp'], group: 'Playback', run: () => jump(-1) },
  { id: 'edit.next', label: 'Next edit point', keys: ['ArrowDown'], group: 'Playback', run: () => jump(1) },
  { id: 'mark.in', label: 'Mark in', keys: ['i'], group: 'Playback', run: () => tl().setIn(tl().playhead) },
  { id: 'mark.out', label: 'Mark out', keys: ['o'], group: 'Playback', run: () => tl().setOut(tl().playhead) },
  { id: 'mark.clear', label: 'Clear in / out', keys: ['Alt+x'], group: 'Playback', run: () => (tl().setIn(null), tl().setOut(null)) },
  { id: 'loop', label: 'Toggle loop', keys: ['Mod+Shift+l'], group: 'Playback', run: () => tl().toggleLoop() },

  { id: 'tool.select', label: 'Selection tool', keys: ['v'], group: 'Tools', run: () => tl().setTool('select') },
  { id: 'tool.blade', label: 'Blade tool', keys: ['c'], group: 'Tools', run: () => tl().setTool('blade') },
  { id: 'tool.forward', label: 'Track select forward', keys: ['a'], group: 'Tools', run: () => tl().setTool('forward') },
  { id: 'snap', label: 'Toggle snapping', keys: ['s'], group: 'Tools', run: () => tl().toggleSnapping() },
  { id: 'linked', label: 'Toggle linked selection', keys: ['Shift+l'], group: 'Tools', run: () => tl().toggleLinked() },

  { id: 'edit.split', label: 'Split at playhead', keys: ['Shift+c'], group: 'Edit', run: () => command(() => splitAtPlayhead(seq()!, tl().playhead, tl().selection), 'Split at playhead') },
  { id: 'edit.delete', label: 'Delete selection', keys: ['Delete', 'Backspace'], group: 'Edit', run: () => command(() => deleteItems(seq()!, [...tl().selection], false), 'Delete') },
  { id: 'edit.rippleDelete', label: 'Ripple delete selection', keys: ['Shift+Delete', 'Shift+Backspace'], group: 'Edit', run: () => command(() => deleteItems(seq()!, [...tl().selection], true), 'Ripple delete') },
  { id: 'edit.trimStart', label: 'Ripple trim start to playhead', keys: ['q'], group: 'Edit', run: () => command(() => rippleTrimToPlayhead(seq()!, tl().playhead, 'start', tl().selection), 'Ripple trim start') },
  { id: 'edit.trimEnd', label: 'Ripple trim end to playhead', keys: ['w'], group: 'Edit', run: () => command(() => rippleTrimToPlayhead(seq()!, tl().playhead, 'end', tl().selection), 'Ripple trim end') },
  { id: 'edit.insert', label: 'Insert selected media at playhead', keys: [','], group: 'Edit', run: () => placeSelectedMedia('insert') },
  { id: 'edit.overwrite', label: 'Overwrite with selected media', keys: ['.'], group: 'Edit', run: () => placeSelectedMedia('overwrite') },
  { id: 'edit.marker', label: 'Add marker', keys: ['m'], group: 'Edit', run: () => command(() => addMarkerAt(tl().playhead), 'Add marker') },
  { id: 'edit.undo', label: 'Undo', keys: ['Mod+z'], group: 'Edit', run: async () => { try { await app().undo(); } catch (e) { tl().say((e as Error).message, 'error'); } } },
  { id: 'edit.redo', label: 'Redo', keys: ['Mod+Shift+z', 'Mod+y'], group: 'Edit', run: async () => { try { await app().redo(); } catch (e) { tl().say((e as Error).message, 'error'); } } },
  { id: 'select.all', label: 'Select all', keys: ['Mod+a'], group: 'Edit', run: () => tl().select(selectedOrAll()) },
  { id: 'select.none', label: 'Deselect', keys: ['Escape'], group: 'Edit', run: () => tl().clearSelection() },
  { id: 'select.linked', label: 'Select linked clips', keys: [], group: 'Edit', run: () => { const s = seq(); if (s) tl().select(expandLinked(s, tl().selection)); } },

  { id: 'view.zoomIn', label: 'Zoom in', keys: ['=', '+'], group: 'View', run: () => tl().zoom(1.4, tl().view.width / 2, seq()) },
  { id: 'view.zoomOut', label: 'Zoom out', keys: ['-'], group: 'View', run: () => tl().zoom(1 / 1.4, tl().view.width / 2, seq()) },
  { id: 'view.fit', label: 'Zoom to fit', keys: ['Shift+z'], group: 'View', run: () => tl().fit(seq()) },

  { id: 'app.settings', label: 'Open settings', keys: ['Mod+,'], group: 'App', run: () => useUi.getState().openSettings() },
  { id: 'app.agent', label: 'Focus agent chat', keys: ['Mod+l'], group: 'App', run: () => { const ui = useUi.getState(); if (!ui.rightOpen) ui.toggleRight(); requestAnimationFrame(() => document.getElementById('agent-input')?.focus()); } },
];

/** Platform check, overridable for tests. */
let mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const setMac = (v: boolean): void => void (mac = v);

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/**
 * Normalise a keyboard event to the `Mod+Shift+z` notation used by `Action.keys`.
 * Letters and named keys carry Shift explicitly; symbol keys (`+`, `?`) already encode it in the character.
 */
export function keyOf(e: KeyLike): string {
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  const name = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const symbol = e.key.length === 1 && !/^[a-z]$/i.test(e.key);
  if (e.shiftKey && !symbol) parts.push('Shift');
  parts.push(name);
  return parts.join('+');
}

export function actionFor(e: KeyLike, overrides: Record<string, string[]> = {}): Action | undefined {
  const k = keyOf(e);
  return ACTIONS.find((a) => (overrides[a.id] ?? a.keys).includes(k));
}
