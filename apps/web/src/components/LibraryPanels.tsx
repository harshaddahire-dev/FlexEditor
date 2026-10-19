import { useMemo, useState } from 'react';
import { Captions as CaptionsIcon, Download, Search, Sparkles, Trash2, Wand2 } from 'lucide-react';
import {
  CAPTION_STYLES,
  EFFECTS,
  type CaptionItem,
  type Clip,
  type Track,
  TRANSITIONS,
  captionText,
  captionsForClip,
  captionsToSubtitles,
  findItem,
  frameTicks,
  isCaption,
  isClip,
  retimeWords,
  trackItems,
} from '@cutroom/core';
import { dispatch } from '../lib/actions';
import { makeEnv } from '../lib/env';
import { OpsError, effectOps, transitionOps } from '../lib/clipOps';
import { fetchTranscript } from '../store/analysis';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';
import { ICON } from './ui';

function say(text: string, kind: 'info' | 'error' = 'info'): void {
  useTimeline.getState().say(text, kind);
}

function Filter({ value, onChange, label }: { value: string; onChange(v: string): void; label: string }) {
  return (
    <div className="bin__bar">
      <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
        <Search size={14} strokeWidth={1.5} style={{ position: 'absolute', left: 8, color: 'var(--text-3)' }} />
        <input className="input" style={{ width: '100%', paddingLeft: 26 }} placeholder="Filter" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}

/** Click an effect to put it on the selected video clip(s) with its default settings; tune it in the Inspector. */
export function EffectsPanel() {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const m = new Map<string, typeof EFFECTS>();
    for (const e of EFFECTS.filter((x) => `${x.label} ${x.description} ${x.group}`.toLowerCase().includes(q.toLowerCase()))) m.set(e.group, [...(m.get(e.group) ?? []), e]);
    return [...m.entries()];
  }, [q]);
  const apply = async (type: string, label: string) => {
    const { sequence } = useApp.getState();
    if (!sequence) return;
    try {
      const ok = await dispatch(effectOps(sequence, type, useTimeline.getState().selection), `Apply ${label}`);
      if (ok) say(`${label} added — adjust it in the Inspector.`);
    } catch (e) {
      if (e instanceof OpsError) say(e.message, 'error');
      else throw e;
    }
  };
  return (
    <div className="lib">
      <Filter value={q} onChange={setQ} label="Filter effects" />
      <div className="lib__scroll">
        {groups.map(([group, list]) => (
          <section key={group} className="lib__group">
            <h3 className="lib__title">{group}</h3>
            {list.map((e) => (
              <button key={e.type} className="lib__item" onClick={() => void apply(e.type, e.label)} title={e.description}>
                <Sparkles size={14} />
                <span className="lib__name">{e.label}</span>
                <span className="lib__desc faint">{e.description}</span>
              </button>
            ))}
          </section>
        ))}
        {!groups.length ? <p className="faint lib__none">No effect matches “{q}”.</p> : null}
      </div>
      <p className="lib__hint faint">Select a video clip, then click an effect.</p>
    </div>
  );
}

/** Click a transition to apply it to the cut at the end of the selected clip (shortened to the footage available). */
export function TransitionsPanel() {
  const [q, setQ] = useState('');
  const list = TRANSITIONS.filter((t) => `${t.label} ${t.type}`.toLowerCase().includes(q.toLowerCase()));
  const apply = async (type: string, label: string) => {
    const { sequence, media } = useApp.getState();
    if (!sequence) return;
    try {
      const { ops, duration } = transitionOps(sequence, makeEnv(media, sequence), type, useTimeline.getState().selection);
      if (await dispatch(ops, `${label} transition`)) say(`${label}, ${(duration / sequence.timebase.rate).toFixed(2)} s.`);
    } catch (e) {
      if (e instanceof OpsError) say(e.message, 'error');
      else throw e;
    }
  };
  return (
    <div className="lib">
      <Filter value={q} onChange={setQ} label="Filter transitions" />
      <div className="lib__scroll">
        <section className="lib__group">
          {list.map((t) => (
            <button key={t.type} className="lib__item" onClick={() => void apply(t.type, t.label)}>
              <Wand2 size={14} />
              <span className="lib__name">{t.label}</span>
              <span className="lib__desc faint">{t.duration} s</span>
            </button>
          ))}
        </section>
      </div>
      <p className="lib__hint faint">Select a clip that touches another, then click a transition. Needs a little spare footage at the cut.</p>
    </div>
  );
}

const captionTracks = (tracks: Track[]): Track[] => tracks.filter((t) => t.kind === 'caption');

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Generate captions from the transcript of the selected clip(s), restyle them, edit text, export subtitles. */
export function CaptionsPanel() {
  const seq = useApp((s) => s.sequence);
  const [styleId, setStyleId] = useState('default');
  const [busy, setBusy] = useState(false);
  const track = seq ? captionTracks(seq.tracks)[0] : undefined;
  const items = track ? trackItems(track).filter(isCaption) : [];

  const generate = async () => {
    const { sequence, media } = useApp.getState();
    if (!sequence) return;
    const sel = [...useTimeline.getState().selection]
      .map((id) => findItem(sequence, id))
      .filter((f): f is NonNullable<typeof f> => !!f && isClip(f.item));
    // one clip per linked group (the video and its audio share one transcript)
    const seen = new Set<string>();
    const clips: Clip[] = [];
    for (const f of sel) {
      const c = f.item as Clip;
      const key = c.linkGroupId ?? c.id;
      if (!seen.has(key)) (seen.add(key), clips.push(c));
    }
    if (!clips.length) return say('Select the clip(s) to caption on the timeline first.', 'error');
    setBusy(true);
    try {
      const drafts: ReturnType<typeof captionsForClip> = [];
      for (const c of clips.sort((a, b) => a.start - b.start)) {
        const m = media[c.mediaId];
        if (!m) continue;
        if (m.status.transcript !== 'done') {
          say(m.status.transcript === 'unavailable' ? 'Transcription needs whisper.cpp — see the Transcript tab.' : `${m.name} has no transcript yet.`, 'error');
          return;
        }
        const t = await fetchTranscript(m);
        if (t) drafts.push(...captionsForClip(t.words, c, sequence.timebase));
      }
      if (!drafts.length) return say('No speech found in the selected range.', 'error');
      let trackId = track?.id;
      if (!trackId) {
        if (!(await dispatch([{ type: 'addTrack', kind: 'caption' }], 'Add caption track'))) return;
        trackId = captionTracks(useApp.getState().sequence!.tracks)[0]?.id;
      }
      if (!trackId) return;
      if (await dispatch([{ type: 'setCaptions', trackId, items: drafts.map((d) => ({ ...d, styleId })) }], `Generate ${drafts.length} captions`)) say(`${drafts.length} captions created from the transcript.`);
    } finally {
      setBusy(false);
    }
  };

  const restyle = (id: string) => {
    setStyleId(id);
    if (items.length) void dispatch(items.map((c) => ({ type: 'updateCaption' as const, id: c.id, patch: { styleId: id } })), 'Caption style');
  };

  return (
    <div className="lib">
      <div className="lib__scroll">
        <section className="lib__group">
          <h3 className="lib__title">Style</h3>
          <div className="cstyles" role="radiogroup" aria-label="Caption style">
            {CAPTION_STYLES.map((s) => (
              <button key={s.id} role="radio" aria-checked={styleId === s.id} className="cstyle" data-on={styleId === s.id} onClick={() => restyle(s.id)} title={s.description}>
                <span className="cstyle__sample" data-style={s.id}>{s.uppercase ? 'AA' : 'Aa'}</span>
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="lib__group">
          <h3 className="lib__title">Captions</h3>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn--primary btn--sm" onClick={() => void generate()} disabled={busy}><CaptionsIcon {...ICON} />Generate from transcript</button>
            {items.length ? (
              <button className="btn btn--sm" onClick={() => seq && download('captions.srt', captionsToSubtitles(items, seq.timebase))}><Download {...ICON} />SRT</button>
            ) : null}
          </div>
          <p className="faint lib__hint">Uses the transcript of the selected clip(s) and follows trims and speed. Replaces existing captions.</p>
        </section>
        {seq && items.length ? <CaptionList items={items} tb={seq.timebase} /> : null}
      </div>
    </div>
  );
}

function CaptionList({ items, tb }: { items: CaptionItem[]; tb: NonNullable<ReturnType<typeof useApp.getState>['sequence']>['timebase'] }) {
  const f = frameTicks(tb);
  return (
    <ol className="clist" aria-label="Captions on the timeline">
      {items.map((c) => (
        <li key={c.id} className="clist__row">
          <button className="clist__time mono" onClick={() => useTimeline.getState().setPlayhead(c.start, useApp.getState().sequence)} title="Go to this caption">
            {(c.start / tb.rate).toFixed(1)}s
          </button>
          <input
            className="clist__text"
            defaultValue={captionText(c)}
            aria-label={`Caption at ${(c.start / tb.rate).toFixed(1)} seconds`}
            onBlur={(e) => {
              const text = e.target.value.trim();
              if (text && text !== captionText(c)) void dispatch([{ type: 'updateCaption', id: c.id, patch: { words: retimeWords(text, c.start, Math.max(f, c.duration)) } }], 'Edit caption');
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <button className="btn btn--ghost btn--icon btn--xs" aria-label="Delete caption" onClick={() => void dispatch([{ type: 'delete', itemIds: [c.id], linked: false }], 'Delete caption')}><Trash2 size={12} /></button>
        </li>
      ))}
    </ol>
  );
}
