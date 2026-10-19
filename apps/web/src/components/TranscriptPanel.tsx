import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { type Media } from '@cutroom/core';
import { api } from '../lib/api';
import { filterSegments, formatStamp, timelineTimeForSource } from '../lib/transcript';
import { fetchTranscript, type TranscriptData } from '../store/analysis';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';
import { ICON } from './ui';

/** Transcript of the media selected in the bin; clicking a line moves the playhead to where it plays on the timeline. */
export function TranscriptPanel() {
  const media = useApp((s) => (s.selectedMediaId ? s.media[s.selectedMediaId] : undefined));
  const seq = useApp((s) => s.sequence);
  const whisper = useApp((s) => s.health?.whisper);
  const [data, setData] = useState<TranscriptData | null>(null);
  const [query, setQuery] = useState('');
  const state = media?.status.transcript;
  const key = media ? `${media.id}:${media.mtimeMs}:${state}` : '';

  useEffect(() => {
    let live = true;
    setData(null);
    if (media && state === 'done') void fetchTranscript(media).then((t) => live && setData(t));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const shown = useMemo(() => filterSegments(data?.segments ?? [], query), [data, query]);
  if (!media) return <div className="empty"><p>Select media in the bin to read its transcript.</p></div>;
  if (state === 'skipped') return <div className="empty"><p>{media.name} has no speech track to transcribe.</p></div>;
  if (state === 'unavailable') return <Unavailable media={media} hint={whisper?.hint} />;
  if (state === 'failed') return <div className="empty"><p>Transcription failed.</p><button className="btn btn--sm" onClick={() => void api.analyze(media.id)}>Try again</button></div>;
  if (state !== 'done') return <div className="empty"><p role="status">{state === 'running' ? 'Transcribing…' : 'Waiting to transcribe…'}</p></div>;
  if (!data) return <div className="empty"><p role="status">Loading transcript…</p></div>;

  const seek = (ms: number) => {
    if (!seq) return;
    const ticks = (ms / 1000) * seq.timebase.rate;
    const at = timelineTimeForSource(seq, media.id, ticks);
    const tl = useTimeline.getState();
    if (at === null) tl.say('That moment is not on the timeline yet.');
    else tl.setPlayhead(at, seq);
  };

  return (
    <div className="transcript">
      <div className="transcript__search">
        <Search {...ICON} />
        <input aria-label="Search transcript" placeholder="Search words…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="faint">{data.words.length} words · {data.language}</span>
      </div>
      <ol className="transcript__list" aria-label="Transcript">
        {shown.length === 0 ? <li className="faint transcript__none">No matches.</li> : null}
        {shown.map((s) => (
          <li key={s.wordStart}>
            <button className="transcript__row" onClick={() => seek(s.startMs)} title="Go to this line on the timeline">
              <span className="transcript__stamp">{formatStamp(s.startMs)}</span>
              <span>{s.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Unavailable({ media, hint }: { media: Media; hint?: string }) {
  return (
    <div className="empty">
      <p>Transcription needs whisper.cpp.</p>
      <p className="faint">{hint ?? 'Install whisper.cpp and a ggml model.'}</p>
      <button className="btn btn--sm" onClick={() => void api.analyze(media.id)}>Check again</button>
    </div>
  );
}
