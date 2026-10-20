import { type PointerEvent as RPointerEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lock, LockOpen, Magnet, MousePointer2, Link2, Scissors, ChevronsRight, Volume2, VolumeX, ZoomIn, ZoomOut, Maximize2, Headphones, Eye, EyeOff } from 'lucide-react';
import { type Op, type Sequence, framesToTimecode, frameTicks, isClip, itemEnd, sequenceDuration, trackItems } from '@cutroom/core';
import { ACTIONS, dispatch } from '../lib/actions';
import { dryRun, makeEnv } from '../lib/env';
import { mediaUrl } from '../lib/api';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';
import { reviewDiff, useAgent } from '../store/agent';
import { filmstripOf, silencesOf, useAnalysis, waveformOf } from '../store/analysis';
import { useUi } from '../store/ui';
import { CommandError, expandLinked, moveSelection, placeMedia, selectForward, splitClipAt } from '../timeline/commands';
import { HEADER_W, RULER_H, hitTest, snapPoints, snapTicks, trackRows, xToTicks, type Hit } from '../timeline/geometry';
import { type Preview, drawTimeline, readTheme, timelineStats, type Theme } from '../timeline/render';
import { ICON, Tip } from './ui';

export const MEDIA_MIME = 'application/x-cutroom-media';

type Drag =
  | { kind: 'scrub' }
  | { kind: 'pan'; x0: number; y0: number; sx: number; sy: number }
  | { kind: 'move'; x0: number; y0: number; startTicks: number; ids: string[]; explicit: string[]; moved: boolean; lastCheck: number }
  | { kind: 'trim'; itemId: string; edge: 'start' | 'end'; roll?: { rightId: string } };

function Toolbar({ seq }: { seq: Sequence }) {
  const tl = useTimeline();
  const total = sequenceDuration(seq);
  const fps = seq.timebase.fps;
  const f = frameTicks(seq.timebase);
  const tc = (t: number) => framesToTicksSafe(t, f, fps);
  const zoomSlider = Math.log(tl.view.pps / 0.5) / Math.log(20000 / 0.5);

  return (
    <div className="tlbar" role="toolbar" aria-label="Timeline tools">
      <div className="seg" role="group" aria-label="Tool">
        {([['select', 'Selection (V)', MousePointer2], ['blade', 'Blade (C)', Scissors], ['forward', 'Track select forward (A)', ChevronsRight]] as const).map(([id, label, Icon]) => (
          <Tip key={id} label={label}>
            <button className="seg__btn" data-state={tl.tool === id ? 'on' : 'off'} aria-label={label} aria-pressed={tl.tool === id} onClick={() => tl.setTool(id)} style={{ padding: '0 8px' }}>
              <Icon {...ICON} />
            </button>
          </Tip>
        ))}
      </div>
      <Tip label="Snapping (S)">
        <button className="btn btn--ghost btn--icon" aria-label="Snapping" aria-pressed={tl.snapping} data-on={tl.snapping} onClick={tl.toggleSnapping}><Magnet {...ICON} /></button>
      </Tip>
      <Tip label="Linked selection (Shift+L)">
        <button className="btn btn--ghost btn--icon" aria-label="Linked selection" aria-pressed={tl.linkedSelection} data-on={tl.linkedSelection} onClick={tl.toggleLinked}><Link2 {...ICON} /></button>
      </Tip>
      <span className="tlbar__tc mono" aria-label="Playhead timecode">{tc(tl.playhead)}</span>
      <span className="faint mono" aria-label="Sequence duration">/ {tc(total)}</span>
      {tl.status ? <span className="tlbar__status" data-kind={tl.status.kind} role={tl.status.kind === 'error' ? 'alert' : 'status'}>{tl.status.text}</span> : null}
      <span className="spacer" />
      <Tip label="Zoom out (−)"><button className="btn btn--ghost btn--icon" aria-label="Zoom out" onClick={() => tl.zoom(1 / 1.4, tl.view.width / 2, seq)}><ZoomOut {...ICON} /></button></Tip>
      <input
        className="tlbar__zoom"
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={Math.min(1, Math.max(0, zoomSlider))}
        aria-label="Zoom"
        onChange={(e) => {
          const pps = 0.5 * Math.pow(20000 / 0.5, Number(e.target.value));
          tl.zoom(pps / tl.view.pps, tl.view.width / 2, seq);
        }}
      />
      <Tip label="Zoom in (+)"><button className="btn btn--ghost btn--icon" aria-label="Zoom in" onClick={() => tl.zoom(1.4, tl.view.width / 2, seq)}><ZoomIn {...ICON} /></button></Tip>
      <Tip label="Zoom to fit (Shift+Z)"><button className="btn btn--ghost btn--icon" aria-label="Zoom to fit" onClick={() => tl.fit(seq)}><Maximize2 {...ICON} /></button></Tip>
    </div>
  );
}

function framesToTicksSafe(t: number, f: number, fps: Sequence['timebase']['fps']): string {
  return framesToTimecode(Math.round(t / f), fps);
}

function Headers({ seq }: { seq: Sequence }) {
  const scrollY = useTimeline((s) => s.view.scrollY);
  const rows = useMemo(() => trackRows(seq), [seq]);
  const set = (trackId: string, patch: Record<string, unknown>, label: string) => void dispatch([{ type: 'setTrackProps', trackId, patch }], label);
  return (
    <div className="tlh" style={{ width: HEADER_W }}>
      <div className="tlh__corner" style={{ height: RULER_H }} />
      <div className="tlh__rows">
        {rows.map(({ track, y, h }) => (
          <div key={track.id} className="tlh__row" data-kind={track.kind} data-testid={`track-${track.name}`} style={{ top: y - scrollY, height: h }}>
            <span className="tlh__id">
              <span className="tlh__name" title={track.name}>{track.name}</span>
              {h >= 44 ? <span className="tlh__kind">{track.kind === 'video' ? 'Video' : track.kind === 'audio' ? 'Audio' : track.kind}</span> : null}
            </span>
            <div className="tlh__btns">
              <Tip label={track.kind === 'video' ? (track.muted ? 'Show track' : 'Hide track') : track.muted ? 'Unmute' : 'Mute'}>
                <button
                  className="tlh__btn"
                  aria-label={`${track.kind === 'video' ? (track.muted ? 'Show' : 'Hide') : track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
                  aria-pressed={track.muted}
                  data-on={track.muted}
                  onClick={() => set(track.id, { muted: !track.muted }, `${track.kind === 'video' ? (track.muted ? 'Show' : 'Hide') : track.muted ? 'Unmute' : 'Mute'} ${track.name}`)}
                >
                  {track.kind === 'video' ? (track.muted ? <EyeOff size={13} strokeWidth={1.5} /> : <Eye size={13} strokeWidth={1.5} />) : track.muted ? <VolumeX size={13} strokeWidth={1.5} /> : <Volume2 size={13} strokeWidth={1.5} />}
                </button>
              </Tip>
              {track.kind === 'audio' ? (
                <Tip label={track.solo ? 'Unsolo' : 'Solo'}>
                  <button className="tlh__btn" aria-label={`${track.solo ? 'Unsolo' : 'Solo'} ${track.name}`} aria-pressed={track.solo} data-on={track.solo} onClick={() => set(track.id, { solo: !track.solo }, `Solo ${track.name}`)}>
                    <Headphones size={13} strokeWidth={1.5} />
                  </button>
                </Tip>
              ) : null}
              <Tip label={track.locked ? 'Unlock' : 'Lock'}>
                <button className="tlh__btn" aria-label={`${track.locked ? 'Unlock' : 'Lock'} ${track.name}`} aria-pressed={track.locked} data-on={track.locked} onClick={() => set(track.id, { locked: !track.locked }, `${track.locked ? 'Unlock' : 'Lock'} ${track.name}`)}>
                  {track.locked ? <Lock size={13} strokeWidth={1.5} /> : <LockOpen size={13} strokeWidth={1.5} />}
                </button>
              </Tip>
            </div>
            <TrackResizer trackId={track.id} height={h} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Drag the bottom edge of a track header to change its height (committed once, on release). */
function TrackResizer({ trackId, height }: { trackId: string; height: number }) {
  const start = useRef<{ y: number; h: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  void live;
  return (
    <div
      className="tlh__resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize track"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); start.current = { y: e.clientY, h: height }; }}
      onPointerMove={(e) => { if (start.current) setLive(Math.max(20, Math.min(240, Math.round(start.current.h + e.clientY - start.current.y)))); }}
      onPointerUp={() => {
        const h = live;
        start.current = null;
        setLive(null);
        if (h && h !== height) void dispatch([{ type: 'setTrackProps', trackId, patch: { height: h } }], 'Resize track');
      }}
    />
  );
}

export function TimelinePanel() {
  const project = useApp((s) => s.project);
  const seq = useApp((s) => s.sequence);
  if (!project) return null;
  return (
    <section className="panel panel--timeline" aria-label="Timeline">
      {seq ? (
        <>
          <Toolbar seq={seq} />
          <TimelineBody />
        </>
      ) : (
        <div className="empty"><p>Opening sequence…</p></div>
      )}
    </section>
  );
}

function TimelineBody() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useRef<Theme | null>(null);
  const raf = useRef(0);
  const preview = useRef<Preview | null>(null);
  const hover = useRef<string | null>(null);
  const guide = useRef<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const posters = useRef(new Map<string, HTMLImageElement>());
  const spaceDown = useRef(false);
  const themeName = useUi((s) => s.theme);
  const seq = useApp((s) => s.sequence)!;
  const isEmpty = useMemo(() => !seq.tracks.some((t) => Object.keys(t.items).length), [seq]);

  const draw = useCallback(() => {
    raf.current = 0;
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    const app = useApp.getState();
    const s = app.sequence;
    if (!c || !ctx || !s) return;
    const t = useTimeline.getState();
    theme.current ??= readTheme();
    const dpr = window.devicePixelRatio || 1;
    const w = c.width / dpr;
    const h = c.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const started = performance.now();
    drawTimeline(ctx, {
      seq: s, view: t.view, theme: theme.current, width: w, height: h, playhead: t.playhead, inPoint: t.inPoint, outPoint: t.outPoint,
      selection: t.selection, hoverId: hover.current, preview: preview.current, snapGuide: guide.current,
      mediaName: (id) => app.media[id]?.name,
      waveform: (id) => waveformOf(app.media[id]),
      filmstrip: (id) => filmstripOf(app.media[id]),
      silences: (id) => silencesOf(app.media[id]),
      review: reviewDiff(),
      poster: (id) => {
        const m = app.media[id];
        if (!m || m.status.poster !== 'done') return null;
        let img = posters.current.get(id);
        if (!img) {
          img = new Image();
          img.onload = invalidate;
          img.src = mediaUrl(id, 'poster', m.mtimeMs);
          posters.current.set(id, img);
        }
        return img.complete && img.naturalWidth ? img : null;
      },
    });
    const took = performance.now() - started;
    timelineStats.draws++;
    timelineStats.totalMs += took;
    timelineStats.maxMs = Math.max(timelineStats.maxMs, took);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invalidate = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(draw);
  }, [draw]);

  /* size → canvas backing store + view */
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const c = canvas.current!;
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      useTimeline.getState().setView({ width: r.width, height: Math.max(0, r.height - RULER_H) }, useApp.getState().sequence);
      invalidate();
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [invalidate]);

  useEffect(() => {
    theme.current = readTheme();
    invalidate();
  }, [themeName, invalidate]);

  useEffect(() => {
    const unsub = [useTimeline.subscribe(invalidate), useApp.subscribe(invalidate), useAnalysis.subscribe(invalidate), useAgent.subscribe(invalidate)];
    invalidate();
    return () => unsub.forEach((u) => u());
  }, [invalidate]);

  /* keep the playhead visible while it plays */
  useEffect(
    () =>
      useTimeline.subscribe((s, prev) => {
        if (!s.playing || s.playhead === prev.playhead) return;
        const sq = useApp.getState().sequence;
        if (!sq) return;
        const x = (s.playhead / sq.timebase.rate) * s.view.pps - s.view.scrollX;
        if (x > s.view.width - 40 || x < 0) s.setView({ scrollX: (s.playhead / sq.timebase.rate) * s.view.pps - s.view.width * 0.2 }, sq);
      }),
    [],
  );

  useEffect(() => {
    const down = (e: KeyboardEvent) => e.code === 'Space' && !(e.target instanceof HTMLInputElement) && (spaceDown.current = true);
    const up = (e: KeyboardEvent) => e.code === 'Space' && (spaceDown.current = false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => (window.removeEventListener('keydown', down), window.removeEventListener('keyup', up));
  }, []);

  /* ---- pointer helpers ---- */
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top - RULER_H };
  };
  const snapAt = (ticks: number, exclude?: ReadonlySet<string>) => {
    const t = useTimeline.getState();
    const s = useApp.getState().sequence!;
    if (!t.snapping) return { ticks, snappedTo: null as number | null };
    return snapTicks(ticks, snapPoints(s, t.playhead, [], exclude), s.timebase.rate, t.view.pps);
  };
  const frame = () => frameTicks(useApp.getState().sequence!.timebase);
  const toFrame = (t: number) => Math.round(t / frame()) * frame();

  const onPointerDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    const t = useTimeline.getState();
    const app = useApp.getState();
    const s = app.sequence!;
    canvas.current!.setPointerCapture(e.pointerId);
    const { x, y } = local(e);
    if (e.button === 1 || spaceDown.current) {
      drag.current = { kind: 'pan', x0: e.clientX, y0: e.clientY, sx: t.view.scrollX, sy: t.view.scrollY };
      return;
    }
    if (e.button !== 0) return;
    const hit = hitTest(s, t.view, x, y);

    if (hit.kind === 'ruler' || hit.kind === 'marker') {
      drag.current = { kind: 'scrub' };
      const target = hit.kind === 'marker' ? s.markers.find((m) => m.id === hit.markerId)!.time : snapAt(hit.ticks).ticks;
      t.setPlayhead(target, s);
      return;
    }
    if (hit.kind === 'lane') {
      if (!e.shiftKey) t.clearSelection();
      return;
    }
    if (hit.kind !== 'clip') return;
    const item = hit.item;

    if (t.tool === 'blade') {
      void runOps(() => splitClipAt(s, item.id, toFrame(snapAt(hit.ticks).ticks)), 'Blade');
      return;
    }
    if (t.tool === 'forward') {
      t.select(selectForward(s, hit.track.id, hit.ticks, e.shiftKey), 'replace');
      return;
    }
    const group = t.linkedSelection && isClip(item) ? expandLinked(s, [item.id]) : [item.id];
    if (hit.part !== 'body') {
      t.select(group, 'replace');
      let roll: { rightId: string } | undefined;
      if ((e.ctrlKey || e.metaKey) && isClip(item)) {
        const cut = hit.part === 'end' ? itemEnd(item) : item.start;
        const other = trackItems(hit.track).find((i) => (hit.part === 'end' ? i.start === cut : itemEnd(i) === cut) && i.id !== item.id);
        if (other && isClip(other)) roll = { rightId: hit.part === 'end' ? other.id : item.id };
        if (other && hit.part === 'start') {
          drag.current = { kind: 'trim', itemId: other.id, edge: 'end', roll: { rightId: item.id } };
          return;
        }
      }
      drag.current = { kind: 'trim', itemId: item.id, edge: hit.part, roll };
      return;
    }
    if (e.shiftKey) t.select(group, 'toggle');
    else if (!t.selection.has(item.id)) t.select(group, 'replace');
    const ids = [...useTimeline.getState().selection];
    drag.current = { kind: 'move', x0: e.clientX, y0: e.clientY, startTicks: hit.ticks, ids, explicit: [item.id], moved: false, lastCheck: 0 };
  };

  const onPointerMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const t = useTimeline.getState();
    const app = useApp.getState();
    const s = app.sequence!;
    const { x, y } = local(e);
    const d = drag.current;

    if (!d) {
      const hit = hitTest(s, t.view, x, y);
      const id = hit.kind === 'clip' ? hit.item.id : null;
      let cursor = 'default';
      if (hit.kind === 'ruler' || hit.kind === 'marker') cursor = 'pointer';
      else if (hit.kind === 'clip') cursor = t.tool === 'blade' ? 'crosshair' : hit.part === 'body' ? (t.tool === 'forward' ? 'e-resize' : 'grab') : 'ew-resize';
      canvas.current!.style.cursor = cursor;
      if (id !== hover.current) {
        hover.current = id;
        invalidate();
      }
      return;
    }
    if (d.kind === 'pan') {
      t.setView({ scrollX: d.sx - (e.clientX - d.x0), scrollY: d.sy - (e.clientY - d.y0) }, s);
    } else if (d.kind === 'scrub') {
      const sn = snapAt(xToTicks(x, s.timebase.rate, t.view));
      guide.current = sn.snappedTo;
      t.setPlayhead(sn.ticks, s);
    } else if (d.kind === 'move') {
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      d.moved = true;
      const exclude = new Set(d.ids);
      let delta = xToTicks(x, s.timebase.rate, t.view) - d.startTicks;
      // snap the nearest edge of any moving item
      let best: { adj: number; at: number } | null = null;
      if (t.snapping) {
        for (const id of d.ids) {
          const it = s.tracks.map((tr) => tr.items[id]).find(Boolean);
          if (!it) continue;
          for (const edge of [it.start + delta, itemEnd(it) + delta]) {
            const sn = snapTicks(edge, snapPoints(s, t.playhead, [], exclude), s.timebase.rate, t.view.pps);
            if (sn.snappedTo !== null && (!best || Math.abs(sn.snappedTo - edge) < Math.abs(best.adj))) best = { adj: sn.snappedTo - edge, at: sn.snappedTo };
          }
        }
      }
      if (best) delta += best.adj;
      guide.current = best?.at ?? null;
      delta = Math.round(delta / frame()) * frame();
      // vertical drag moves a single clip to another track of the same kind
      let toTrackId: string | undefined;
      if (d.explicit.length === 1) {
        const hit = hitTest(s, t.view, x, y);
        const lane = hit.kind === 'lane' || hit.kind === 'clip' ? hit.track : undefined;
        const src = s.tracks.find((tr) => tr.items[d.explicit[0]!]);
        if (lane && src && lane.id !== src.id && lane.kind === src.kind) toTrackId = lane.id;
      }
      const next: Preview = { kind: 'move', ids: exclude, delta, toTrackId };
      // ask the real engine whether this would be allowed (throttled)
      const now = performance.now();
      if (now - d.lastCheck > 90) {
        d.lastCheck = now;
        try {
          const ops = moveSelection(s, d.ids, delta, { toTrackId, overwrite: e.altKey });
          next.invalid = dryRun(s, ops, makeEnv(app.media, s)) !== null;
        } catch {
          next.invalid = true;
        }
      } else if (preview.current?.kind === 'move') next.invalid = preview.current.invalid;
      preview.current = next;
    } else if (d.kind === 'trim') {
      const exclude = new Set([d.itemId]);
      const sn = snapAt(xToTicks(x, s.timebase.rate, t.view), exclude);
      guide.current = sn.snappedTo;
      preview.current = { kind: 'trim', id: d.itemId, edge: d.edge, to: toFrame(sn.ticks), ripple: e.altKey };
    }
    invalidate();
  };

  const finish = async (e: RPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const pv = preview.current;
    drag.current = null;
    guide.current = null;
    const s = useApp.getState().sequence!;
    const t = useTimeline.getState();
    if (d?.kind === 'move' && d.moved && pv?.kind === 'move') {
      await runOps(() => moveSelection(s, d.ids, pv.delta, { toTrackId: pv.toTrackId, overwrite: e.altKey }), 'Move');
    } else if (d?.kind === 'trim' && pv?.kind === 'trim') {
      const item = s.tracks.map((tr) => tr.items[d.itemId]).find(Boolean);
      if (item) {
        const ops: Op[] = d.roll
          ? [{ type: 'rollTrim', leftClipId: d.itemId, rightClipId: d.roll.rightId, to: pv.to, linked: t.linkedSelection }]
          : isClip(item)
            ? [{ type: pv.ripple ? 'rippleTrim' : 'trim', clipId: item.id, edge: d.edge, to: pv.to, linked: t.linkedSelection }]
            : [{ type: 'updateCaption', id: item.id, patch: d.edge === 'start' ? { start: pv.to, duration: itemEnd(item) - pv.to } : { duration: pv.to - item.start } }];
        await runOps(() => ops, 'Trim');
      }
    }
    preview.current = null;
    invalidate();
  };

  /** Validate with the engine, then send; the ghost stays up until the confirmed sequence replaces it. */
  async function runOps(build: () => Op[], label: string): Promise<void> {
    const app = useApp.getState();
    const s = app.sequence!;
    try {
      const ops = build();
      const why = dryRun(s, ops, makeEnv(app.media, s));
      if (why) return useTimeline.getState().say(why, 'error');
      await dispatch(ops, label);
    } catch (err) {
      if (err instanceof CommandError) useTimeline.getState().say(err.message, 'error');
      else throw err;
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    const t = useTimeline.getState();
    const s = useApp.getState().sequence!;
    const { x } = local(e);
    if (e.ctrlKey || e.metaKey) t.zoom(Math.exp(-e.deltaY * 0.0022), x, s);
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) t.setView({ scrollX: t.view.scrollX + (e.deltaX || e.deltaY) }, s);
    else t.setView({ scrollY: t.view.scrollY + e.deltaY }, s);
  };

  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(MEDIA_MIME);
    if (!id) return;
    e.preventDefault();
    const app = useApp.getState();
    const s = app.sequence!;
    const m = app.media[id];
    const t = useTimeline.getState();
    const { x, y } = local(e);
    const hit = hitTest(s, t.view, x, y);
    const track = hit.kind === 'lane' || hit.kind === 'clip' ? hit.track.id : undefined;
    const at = toFrame(snapAt(xToTicks(x, s.timebase.rate, t.view)).ticks);
    if (m) void runOps(() => placeMedia(s, [m], Math.max(0, at), 'overwrite', track), 'Add clip');
  };

  return (
    <div className="tl">
      <Headers seq={seq} />
      <div className="tl__stage" ref={wrap}>
        <canvas
          ref={canvas}
          role="application"
          aria-roledescription="timeline"
          aria-describedby="tl-help"
          aria-label="Timeline canvas"
          data-testid="timeline-canvas"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => void finish(e)}
          onPointerCancel={(e) => void finish(e)}
          onPointerLeave={() => { if (!drag.current && hover.current) { hover.current = null; invalidate(); } }}
          onWheel={onWheel}
          onDragOver={(e) => e.dataTransfer.types.includes(MEDIA_MIME) && e.preventDefault()}
          onDrop={onDrop}
          onContextMenu={(e) => e.preventDefault()}
        />
        <ClipList seq={seq} />
        {isEmpty ? (
          <div className="tl__empty" aria-live="polite">
            <p>The timeline is empty.</p>
            <p className="faint">Drag media here, or select it in the bin and press <span className="kbd">,</span> to insert at the playhead.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const ClipRow = memo(function ClipRow({ id, label, start, pressed }: { id: string; label: string; start: number; pressed: boolean }) {
  return (
    <li>
      <button type="button" aria-pressed={pressed} onClick={() => { const t = useTimeline.getState(); t.select([id]); t.setPlayhead(start, useApp.getState().sequence); }}>{label}</button>
    </li>
  );
});

/**
 * The timeline is a canvas, which assistive technology cannot read. This is its text twin: instructions, a list of every clip
 * (activate one to select it and move the playhead there) and the current selection announced as it changes.
 */
function ClipList({ seq }: { seq: Sequence }) {
  const media = useApp((s) => s.media);
  const selection = useTimeline((s) => s.selection);
  const f = frameTicks(seq.timebase);
  const tc = (t: number) => framesToTimecode(Math.round(t / f), seq.timebase.fps);
  const items = useMemo(() => {
    const out: { id: string; label: string; start: number }[] = [];
    for (const track of seq.tracks) {
      for (const item of trackItems(track)) {
        if (out.length >= 500) break;
        const name = isClip(item) ? (media[item.mediaId]?.name ?? item.name ?? 'clip') : item.words.map((w) => w.text).join(' ').slice(0, 40) || 'caption';
        out.push({ id: item.id, start: item.start, label: `${name} · ${track.name} · ${tc(item.start)} to ${tc(itemEnd(item))}` });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, media]);
  const chosen = items.filter((i) => selection.has(i.id));
  // the list itself only changes when the clips do; a selection change just flips aria-pressed on a few rows
  const rows = useMemo(
    () => items.map((i) => ({ ...i, pressed: false })),
    [items],
  );
  return (
    <>
      <p id="tl-help" className="sr-only">
        Timeline. Use the arrow keys to move the playhead by a frame, Home and End to jump to the start and end, Up and Down to move between edit points, S to toggle snapping, Shift+C to split at the playhead and Delete to remove the selection.
        A list of every clip follows the timeline: press Enter on a clip to select it and move the playhead to it.
      </p>
      <ul className="sr-only" aria-label="Timeline clips">
        {rows.map((i) => (
          <ClipRow key={i.id} id={i.id} label={i.label} start={i.start} pressed={selection.has(i.id)} />
        ))}
      </ul>
      <div className="sr-only" role="status" aria-label="Selection">{chosen.length ? `Selected ${chosen.length === 1 ? chosen[0]!.label : `${chosen.length} items`}` : 'Nothing selected'}</div>
    </>
  );
}

export { ACTIONS };
