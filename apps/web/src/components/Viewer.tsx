import { type ReactElement, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Film, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import type { Media } from '@cutroom/core';
import { mediaUrl } from '../lib/api';
import { formatBytes, formatDuration, formatFps } from '../lib/format';
import { framesToTimecode, frameTicks, sequenceDuration } from '@cutroom/core';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';
import { audio } from '../audio/engine';
import { ACTIONS } from '../lib/actions';
import { engine, useViewerStatus } from '../playback/engine';
import { ICON, Tip } from './ui';

type Group = { title: string; rows: [string, string][] };

/** Media facts grouped the way an editor scans them: file, picture, sound, then what analysis found. */
function info(m: Media, fps: Parameters<typeof formatDuration>[1]): Group[] {
  const file: [string, string][] = [['Type', m.type], ['Size', formatBytes(m.sizeBytes)]];
  if (m.type !== 'image') file.push(['Duration', formatDuration(m.duration, m.fps ?? fps)]);
  const picture: [string, string][] = [];
  const v = m.video;
  if (v) {
    const display = `${v.width}×${v.height}`;
    const coded = `${v.codedWidth}×${v.codedHeight}`;
    picture.push(['Resolution', display === coded ? display : `${display} (coded ${coded})`]);
    if (m.fps) picture.push(['Frame rate', `${formatFps(m.fps)} fps${v.vfr ? ' · variable → constant in proxy' : ''}`]);
    picture.push(['Video', `${v.codec} ${v.bitDepth}-bit ${v.pixFmt ?? ''}`.trim()]);
    picture.push(['Colour', [v.colorRange, v.colorSpace, v.colorTransfer, v.hdr ? 'HDR' : null].filter(Boolean).join(' · ') || 'untagged']);
    if (v.rotation) picture.push(['Rotation', `${v.rotation}°`]);
  }
  if (m.proxy) picture.push(['Proxy', `${m.proxy.width}×${m.proxy.height} @ ${formatFps(m.proxy.fps)} fps`]);
  const a = m.analysis as Record<string, Record<string, number | string | null> | undefined>;
  const sound: [string, string][] = [];
  if (m.audio) sound.push(['Audio', `${m.audio.codec} · ${m.audio.channels} ch · ${m.audio.sampleRate / 1000} kHz`]);
  const l = a.loudness;
  if (l && typeof l.integrated === 'number') sound.push(['Loudness', `${l.integrated.toFixed(1)} LUFS · range ${Number(l.range).toFixed(1)} LU · peak ${Number(l.truePeak).toFixed(1)} dBTP`]);
  else if (l) sound.push(['Loudness', 'silent']);
  const b = a.beats;
  if (b && Number(b.bpm) > 0 && Number(b.confidence) > 0.3) sound.push(['Tempo', `${Number(b.bpm).toFixed(0)} BPM`]);
  const si = a.silences;
  if (si) sound.push(['Silence', `${si.count} gap${si.count === 1 ? '' : 's'} · ${Number(si.totalSeconds).toFixed(1)} s`]);
  const found: [string, string][] = [];
  const sc = a.scenes;
  if (sc) found.push(['Shots', `${Number(sc.count) + 1}`]);
  const tr = a.transcript;
  if (tr && typeof tr.words === 'number') found.push(['Transcript', `${tr.words} words · ${tr.language}`]);
  const groups: Group[] = [{ title: 'File', rows: [...file, ['Path', m.path]] }];
  if (picture.length) groups.push({ title: 'Picture', rows: picture });
  if (sound.length) groups.push({ title: 'Sound', rows: sound });
  if (found.length) groups.push({ title: 'Found', rows: found });
  return groups;
}

type Mode = 'program' | 'source';

/** Stereo peak meter fed by the live audio graph (-60…0 dBFS). Reads the analysers each frame while playing. */
function LevelMeter() {
  const playing = useTimeline((s) => s.playing);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let raf = 0;
    const paint = () => {
      const lv = playing ? audio.levels() : [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
      lv.forEach((db, i) => {
        const el = bars.current[i];
        if (!el) return;
        el.style.width = `${Math.max(0, Math.min(1, (db + 60) / 60)) * 100}%`;
        el.dataset.clip = db > -0.5 ? 'true' : 'false';
      });
      if (playing) raf = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  return (
    <div className="meter" role="img" aria-label="Output level">
      {[0, 1].map((i) => (
        <div key={i} className="meter__lane"><span ref={(el) => { bars.current[i] = el; }} className="meter__bar" /></div>
      ))}
    </div>
  );
}

function run(id: string): void {
  void ACTIONS.find((x) => x.id === id)?.run();
}

/** Timecode, transport buttons and level meter under the program monitor. */
function TransportBar() {
  const seq = useApp((s) => s.sequence);
  const playhead = useTimeline((s) => s.playhead);
  const playing = useTimeline((s) => s.playing);
  const loop = useTimeline((s) => s.loop);
  const tb = seq?.timebase;
  const tc = (ticks: number) => (tb ? framesToTimecode(Math.round(ticks / frameTicks(tb)), tb.fps) : '00:00:00:00');
  const total = seq ? sequenceDuration(seq) : 0;
  const btn = (id: string, label: string, icon: ReactElement, tip = label) => (
    <Tip label={tip}>
      <button className="xport__btn" aria-label={label} onClick={() => run(id)}>{icon}</button>
    </Tip>
  );
  return (
    <div className="xport" role="toolbar" aria-label="Transport">
      <div className="xport__tc">
        <span className="xport__now" aria-label="Timecode">{tc(playhead)}</span>
        <span className="xport__dur faint" aria-label="Duration">{tc(total)}</span>
      </div>
      <div className="xport__keys">
        {btn('goto.start', 'Go to start', <SkipBack {...ICON} />, 'Go to start (Home)')}
        {btn('step.back', 'Back one frame', <StepBack {...ICON} />, 'Back one frame (←)')}
        <Tip label={playing ? 'Pause (Space)' : 'Play (Space)'}>
          <button className="xport__play" aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing} data-on={playing} onClick={() => run('play')}>
            {playing ? <Pause size={18} strokeWidth={1.75} /> : <Play size={18} strokeWidth={1.75} />}
          </button>
        </Tip>
        {btn('step.fwd', 'Forward one frame', <StepForward {...ICON} />, 'Forward one frame (→)')}
        {btn('goto.end', 'Go to end', <SkipForward {...ICON} />, 'Go to end (End)')}
        <Tip label="Loop (⇧⌘L)">
          <button className="xport__btn" aria-label="Loop" aria-pressed={loop} data-on={loop} onClick={() => run('loop')}><Repeat {...ICON} /></button>
        </Tip>
      </div>
      <div className="xport__right">
        <LevelMeter />
      </div>
    </div>
  );
}

/**
 * Centre panel. Program is the composited sequence at the playhead (WebGL, decoded from proxies); Source shows the
 * media selected in the bin with its metadata. Picking media in the bin switches to Source.
 */
/** "Preparing proxy…" — or, when a proxy could not be made, why, with a way to try again. */
function ProxyNote() {
  const media = useApp((s) => s.media);
  const reproxy = useApp((s) => s.reproxy);
  const failed = Object.values(media).filter((m) => m.status.proxy === 'failed');
  if (!failed.length) return <div className="viewer__note" role="status">Preparing proxy…</div>;
  const first = failed[0]!;
  const why = [...first.warnings].reverse().find((w) => w.startsWith('Proxy generation failed'))?.replace('Proxy generation failed: ', '') ?? 'unknown error';
  return (
    <div className="viewer__note viewer__note--error" role="alert">
      <AlertTriangle {...ICON} />
      <span>
        The proxy for {first.name} could not be made: {why.slice(0, 220)}{' '}
        <button className="btn btn--sm" onClick={() => void reproxy(first.id)}>Try again</button>
      </span>
    </div>
  );
}

export function Viewer() {
  const project = useApp((s) => s.project);
  const seq = useApp((s) => s.sequence);
  const media = useApp((s) => (s.selectedMediaId ? s.media[s.selectedMediaId] : undefined));
  const status = useViewerStatus();
  const [mode, setMode] = useState<Mode>('program');
  const host = useRef<HTMLDivElement>(null);
  const picks = useApp((s) => s.picks);
  useEffect(() => {
    if (picks > 0 && useApp.getState().selectedMediaId) setMode('source');
  }, [picks]);
  const mounted = !!project;
  useEffect(() => {
    if (!mounted || !host.current) return;
    engine.attach(host.current);
    return () => engine.detach();
  }, [mounted]);
  if (!project) return null;
  const fps = project.settings.fps;

  return (
    <section className="panel panel--center" aria-label="Viewer">
      <div className="panel__head viewer__head">
        <div className="seg" role="group" aria-label="Monitor">
          {(['program', 'source'] as const).map((m) => (
            <button key={m} className="seg__btn" data-state={mode === m ? 'on' : 'off'} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'program' ? 'Program' : 'Source'}
            </button>
          ))}
        </div>
        <span className="viewer__title" title={mode === 'source' && media ? media.name : seq?.name}>{mode === 'source' && media ? media.name : seq?.name ?? ''}</span>
        <span className="spacer" />
        {seq ? <span className="viewer__spec mono faint">{seq.width}×{seq.height} · {formatFps(project.settings.fps)} fps</span> : null}
      </div>
      <div className="viewer">
        <div className="viewer__stage" hidden={mode !== 'program'} data-testid="program-monitor">
          <div ref={host} className="viewer__host" />
          {status.error ? <div className="viewer__note viewer__note--error" role="alert"><AlertTriangle {...ICON} />{status.error}</div> : status.waiting ? <ProxyNote /> : null}
        </div>
        {mode === 'program' ? <TransportBar /> : null}
        <div className="viewer__stage" hidden={mode !== 'source'}>
          {media?.status.poster === 'done' ? (
            <img src={mediaUrl(media.id, 'poster', media.mtimeMs)} alt={`Poster frame of ${media.name}`} />
          ) : (
            <div className="empty empty--center">
              {media ? <p>{media.missing ? 'This file is missing — relink it from the bin.' : 'No thumbnail for this item.'}</p> : (
                <>
                  <Film size={28} strokeWidth={1.25} />
                  <p>Select media in the bin to inspect it.</p>
                  <p className="faint">Double-click an item to add it to the timeline.</p>
                </>
              )}
            </div>
          )}
        </div>
        {mode === 'source' && media ? (
          <div className="info" role="group" aria-label="Media details">
            {info(media, fps).map((g) => (
              <section key={g.title} className="info__group">
                <h3 className="info__title">{g.title}</h3>
                <dl>
                  {g.rows.map(([k, v]) => (
                    <div key={k} className="info__row">
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
            {media.warnings.map((w) => (
              <div key={w} className="info__warn"><AlertTriangle {...ICON} style={{ flex: 'none' }} />{w}</div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
