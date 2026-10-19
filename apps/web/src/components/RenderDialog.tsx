import { Check, Download, FileVideo, Loader2, TriangleAlert } from 'lucide-react';
import { EXPORT_PRESETS, type CaptionExport, exportPreset, framesToTimecode } from '@cutroom/core';
import { useApp } from '../store/app';
import { hasCaptions, useExport, type EngineChoice } from '../store/export';
import { useTimeline } from '../store/timeline';
import { ICON, Modal } from './ui';

const CAPTION_OPTIONS: { id: CaptionExport; label: string; hint: string }[] = [
  { id: 'burn', label: 'Burn in', hint: 'Captions are part of the picture' },
  { id: 'sidecar', label: 'Subtitle files', hint: '.srt and .vtt next to the video' },
  { id: 'both', label: 'Both', hint: 'Burned in, plus .srt and .vtt' },
  { id: 'none', label: 'None', hint: 'Leave captions out' },
];

const ENGINES: { id: EngineChoice; label: string }[] = [
  { id: 'auto', label: 'Automatic' },
  { id: 'webcodecs', label: 'Browser (WebCodecs)' },
  { id: 'ffmpeg', label: 'FFmpeg' },
];

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Render settings, progress and the finished file. */
export function RenderDialog() {
  const s = useExport();
  const seq = useApp((x) => x.sequence);
  const { inPoint, outPoint } = useTimeline();
  const preset = exportPreset(s.preset);
  const captionsOnTimeline = hasCaptions();
  const tcOf = (ticks: number) => (seq ? framesToTimecode(Math.round(ticks / (seq.timebase.rate / (seq.timebase.fps.num / seq.timebase.fps.den))), seq.timebase.fps) : '');
  const done = s.info?.phase === 'done' && !!s.info.output && !s.running;
  const duration = seq ? Math.max(0, ...seq.tracks.flatMap((t) => Object.values(t.items).map((i) => i.start + i.duration))) : 0;
  const marked = inPoint !== null || outPoint !== null;

  return (
    <Modal
      open={s.open}
      onOpenChange={(o) => (o ? s.openDialog() : s.close())}
      title="Render"
      width={560}
      footer={
        s.running ? (
          <button className="btn" onClick={s.cancel}>Cancel render</button>
        ) : done || s.error ? (
          <>
            <button className="btn btn--ghost" onClick={s.reset}>{done ? 'Render another' : 'Back'}</button>
            <button className="btn btn--primary" onClick={s.close}>Close</button>
          </>
        ) : (
          <>
            <button className="btn btn--ghost" onClick={s.close}>Cancel</button>
            <button className="btn btn--primary" disabled={!seq || duration === 0} onClick={() => void s.start()}><Download {...ICON} />Start render</button>
          </>
        )
      }
    >
      {s.running ? (
        <div className="render__run" role="status" aria-live="polite">
          <div className="render__label"><Loader2 size={14} className="spin" /> {s.label}…</div>
          <div className="render__bar" role="progressbar" aria-label="Render progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.progress * 100)}>
            <div className="render__fill" style={{ width: `${Math.round(s.progress * 100)}%` }} />
          </div>
          <div className="faint render__pct">{Math.round(s.progress * 100)}%{s.used ? ` · ${s.used.engine === 'webcodecs' ? 'browser encoder' : 'FFmpeg'}` : ''}</div>
          {s.used?.reason ? <div className="faint">{s.used.reason}</div> : null}
        </div>
      ) : done && s.info ? (
        <div className="render__done" data-testid="render-done">
          <div className="render__ok"><Check {...ICON} /> Rendered</div>
          <dl className="kv">
            <dt className="label">File</dt>
            <dd className="mono render__path">{s.info.output}</dd>
            {s.info.result ? (
              <>
                <dt className="label">Result</dt>
                <dd>
                  {s.info.result.width ? `${s.info.result.width}×${s.info.result.height} · ` : ''}
                  {s.info.result.durationSeconds.toFixed(2)} s{s.info.result.frames ? ` · ${s.info.result.frames} frames` : ''} · {mb(s.info.result.sizeBytes)}
                </dd>
                <dt className="label">Codecs</dt>
                <dd className="mono">{[s.info.result.videoCodec, s.info.result.audioCodec].filter(Boolean).join(' + ')}</dd>
              </>
            ) : null}
            {s.info.sidecars.length ? (
              <>
                <dt className="label">Subtitles</dt>
                <dd className="mono render__path">{s.info.sidecars.map((f) => f.split(/[\\/]/).pop()).join(', ')}</dd>
              </>
            ) : null}
            {s.used ? (
              <>
                <dt className="label">Engine</dt>
                <dd>{s.used.engine === 'webcodecs' ? 'Browser (WebCodecs)' : 'FFmpeg'}{s.used.reason ? <span className="faint"> — {s.used.reason}</span> : null}</dd>
              </>
            ) : null}
          </dl>
          {s.info.warnings.length ? <div className="callout callout--warn ext__warn"><TriangleAlert {...ICON} size={14} /><ul>{s.info.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div> : null}
          <a className="btn" href={`/api/exports/${s.info.id}/file`} download>
            <FileVideo {...ICON} />Download
          </a>
        </div>
      ) : s.error ? (
        <div className="callout" role="alert">{s.error}</div>
      ) : (
        <div className="render__form">
          <div className="label" id="render-preset">Format</div>
          <div className="render__presets" role="radiogroup" aria-labelledby="render-preset">
            {EXPORT_PRESETS.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={s.preset === p.id} className="render__preset" data-on={s.preset === p.id} onClick={() => s.patch({ preset: p.id })}>
                <strong>{p.label}</strong>
                <span className="faint">{p.description}</span>
              </button>
            ))}
          </div>

          <label className="label" htmlFor="render-name">File name</label>
          <div className="render__name">
            <input id="render-name" className="input" value={s.name} onChange={(e) => s.patch({ name: e.target.value })} spellCheck={false} />
            <span className="faint mono">.{preset?.ext}</span>
          </div>
          <p className="faint render__where">Saved in the project's <span className="mono">exports</span> folder.</p>

          <div className="label" id="render-range">Range</div>
          <div className="render__opts" role="radiogroup" aria-labelledby="render-range">
            <button type="button" role="radio" aria-checked={s.range === 'all'} className="pform__kind" data-on={s.range === 'all'} onClick={() => s.patch({ range: 'all' })}>Whole timeline{seq ? ` · ${tcOf(duration)}` : ''}</button>
            <button type="button" role="radio" aria-checked={s.range === 'inout'} className="pform__kind" data-on={s.range === 'inout'} disabled={!marked} onClick={() => s.patch({ range: 'inout' })}>
              In → Out{marked ? ` · ${tcOf(inPoint ?? 0)} – ${tcOf(outPoint ?? duration)}` : ' (set marks with I and O)'}
            </button>
          </div>

          {preset?.video ? (
            <>
              <div className="label" id="render-caps">Captions</div>
              <div className="render__opts" role="radiogroup" aria-labelledby="render-caps">
                {CAPTION_OPTIONS.map((o) => (
                  <button key={o.id} type="button" role="radio" aria-checked={s.captions === o.id} className="pform__kind" data-on={s.captions === o.id} disabled={!captionsOnTimeline && o.id !== 'none'} title={o.hint} onClick={() => s.patch({ captions: o.id })}>{o.label}</button>
                ))}
              </div>
              {!captionsOnTimeline ? <p className="faint render__where">No captions on the timeline yet — generate them in the Captions tab.</p> : null}

              <div className="label">Options</div>
              <label className="pform__check"><input type="checkbox" checked={s.half} onChange={(e) => s.patch({ half: e.target.checked })} /> Half size (e.g. 1080p → 540p)</label>
              <label className="pform__check"><input type="checkbox" checked={s.draft} onChange={(e) => s.patch({ draft: e.target.checked })} /> Draft: render from proxies (fast, lower quality)</label>
              <label className="label" htmlFor="render-engine">Renderer</label>
              <select id="render-engine" className="input" value={s.engine} onChange={(e) => s.patch({ engine: e.target.value as EngineChoice })}>
                {ENGINES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
              <p className="faint render__where">Automatic uses your browser's encoder when it can decode every source file, and FFmpeg otherwise (ProRes always uses FFmpeg).</p>
            </>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
