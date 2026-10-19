import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Media } from '@cutroom/core';
import { mediaUrl } from '../lib/api';
import { formatBytes, formatDuration, formatFps } from '../lib/format';
import { framesToTimecode, frameTicks } from '@cutroom/core';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';
import { audio } from '../audio/engine';
import { engine, useViewerStatus } from '../playback/engine';
import { ICON } from './ui';

function info(m: Media, fps: Parameters<typeof formatDuration>[1]): [string, string][] {
  const rows: [string, string][] = [['Type', m.type], ['Size', formatBytes(m.sizeBytes)]];
  if (m.type !== 'image') rows.push(['Duration', formatDuration(m.duration, m.fps ?? fps)]);
  const v = m.video;
  if (v) {
    const display = `${v.width}×${v.height}`;
    const coded = `${v.codedWidth}×${v.codedHeight}`;
    rows.push(['Resolution', display === coded ? display : `${display} (coded ${coded})`]);
    if (m.fps) rows.push(['Frame rate', `${formatFps(m.fps)} fps${v.vfr ? ' · variable → constant in proxy' : ''}`]);
    rows.push(['Video', `${v.codec} ${v.bitDepth}-bit ${v.pixFmt ?? ''}`.trim()]);
    rows.push(['Colour', [v.colorRange, v.colorSpace, v.colorTransfer, v.hdr ? 'HDR' : null].filter(Boolean).join(' · ') || 'untagged']);
    if (v.rotation) rows.push(['Rotation', `${v.rotation}°`]);
  }
  if (m.audio) rows.push(['Audio', `${m.audio.codec} · ${m.audio.channels} ch · ${m.audio.sampleRate / 1000} kHz`]);
  if (m.proxy) rows.push(['Proxy', `${m.proxy.width}×${m.proxy.height} @ ${formatFps(m.proxy.fps)} fps`]);
  const a = m.analysis as Record<string, Record<string, number | string | null> | undefined>;
  const l = a.loudness;
  if (l && typeof l.integrated === 'number') rows.push(['Loudness', `${l.integrated.toFixed(1)} LUFS · range ${Number(l.range).toFixed(1)} LU · peak ${Number(l.truePeak).toFixed(1)} dBTP`]);
  else if (l) rows.push(['Loudness', 'silent']);
  const b = a.beats;
  if (b && Number(b.bpm) > 0 && Number(b.confidence) > 0.3) rows.push(['Tempo', `${Number(b.bpm).toFixed(0)} BPM`]);
  const si = a.silences;
  if (si) rows.push(['Silence', `${si.count} gap${si.count === 1 ? '' : 's'} · ${Number(si.totalSeconds).toFixed(1)} s`]);
  const sc = a.scenes;
  if (sc) rows.push(['Shots', `${Number(sc.count) + 1}`]);
  const tr = a.transcript;
  if (tr && typeof tr.words === 'number') rows.push(['Transcript', `${tr.words} words · ${tr.language}`]);
  rows.push(['Path', m.path]);
  return rows;
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

/**
 * Centre panel. Program is the composited sequence at the playhead (WebGL, decoded from proxies); Source shows the
 * media selected in the bin with its metadata. Picking media in the bin switches to Source.
 */
export function Viewer() {
  const project = useApp((s) => s.project);
  const seq = useApp((s) => s.sequence);
  const playhead = useTimeline((s) => s.playhead);
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
      <div className="panel__head" style={{ background: 'var(--bg-1)' }}>
        <span className="panel__title">Viewer</span>
        <div className="seg" role="group" aria-label="Monitor">
          {(['program', 'source'] as const).map((m) => (
            <button key={m} className="seg__btn" data-state={mode === m ? 'on' : 'off'} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'program' ? 'Program' : 'Source'}
            </button>
          ))}
        </div>
        <span className="muted">{mode === 'source' && media ? media.name : seq?.name ?? ''}</span>
        <span className="spacer" />
        <LevelMeter />
        <span className="viewer__tc" aria-label="Timecode">{seq ? framesToTimecode(Math.round(playhead / frameTicks(seq.timebase)), seq.timebase.fps) : formatDuration({ num: 0, den: 1 }, fps)}</span>
      </div>
      <div className="viewer">
        <div className="viewer__stage" hidden={mode !== 'program'} data-testid="program-monitor">
          <div ref={host} className="viewer__host" />
          {status.error ? <div className="viewer__note viewer__note--error" role="alert"><AlertTriangle {...ICON} />{status.error}</div> : status.waiting ? <div className="viewer__note" role="status">Preparing proxy…</div> : null}
        </div>
        <div className="viewer__stage" hidden={mode !== 'source'}>
          {media?.status.poster === 'done' ? (
            <img src={mediaUrl(media.id, 'poster', media.mtimeMs)} alt={`Poster frame of ${media.name}`} />
          ) : (
            <div className="empty">
              {media ? <p>{media.missing ? 'This file is missing — relink it from the bin.' : 'No thumbnail for this item.'}</p> : (
                <>
                  <p>Select media in the bin to inspect it.</p>
                  <p className="faint">Playback and the program monitor arrive with the timeline.</p>
                </>
              )}
            </div>
          )}
        </div>
        {mode === 'source' && media ? (
          <dl className="info" aria-label="Media details">
            {info(media, fps).map(([k, v]) => (
              <div key={k} className="info__row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            {media.warnings.map((w) => (
              <div key={w} className="info__warn"><AlertTriangle {...ICON} style={{ flex: 'none' }} />{w}</div>
            ))}
          </dl>
        ) : null}
      </div>
    </section>
  );
}
