import type { AnalysisState, Media } from '@cutroom/core';
import { Tip } from './ui';

type Key = keyof Media['status'];
const STAGES: { id: string; label: string; keys: Key[] }[] = [
  { id: 'probe', label: 'Metadata', keys: ['probe'] },
  { id: 'poster', label: 'Thumbnail', keys: ['poster'] },
  { id: 'proxy', label: 'Edit proxy', keys: ['proxy'] },
  { id: 'audio', label: 'Waveform & levels', keys: ['waveform', 'loudness', 'silences', 'beats'] },
  { id: 'video', label: 'Filmstrip & scenes', keys: ['filmstrip', 'scenes'] },
  { id: 'transcript', label: 'Transcript', keys: ['transcript'] },
];

const WORD: Record<AnalysisState, string> = {
  pending: 'pending',
  queued: 'queued',
  running: 'working',
  done: 'ready',
  failed: 'failed',
  skipped: 'not needed',
  unavailable: 'needs whisper.cpp',
};

/** One state for a group of stages: the most urgent one wins. */
function combine(states: AnalysisState[]): AnalysisState {
  for (const s of ['failed', 'running', 'queued', 'pending', 'unavailable'] as const) if (states.includes(s)) return s;
  return states.every((s) => s === 'skipped') ? 'skipped' : 'done';
}

/** One dot per processing stage; hover for the breakdown. */
export function StatusDots({ media, progress }: { media: Media; progress?: number }) {
  const stages = STAGES.map((s) => ({ ...s, state: combine(s.keys.map((k) => media.status[k] ?? 'pending')) })).filter((s) => s.state !== 'skipped');
  const summary = stages
    .map((s) => `${s.label}: ${WORD[s.state]}${s.id === 'proxy' && s.state === 'running' && progress !== undefined ? ` ${Math.round(progress * 100)}%` : ''}`)
    .join(' · ');
  return (
    <Tip label={summary || 'Ready'}>
      <span className="dots" role="img" aria-label={summary || 'Ready'}>
        {stages.map((s) => (
          <i key={s.id} className="dot" data-state={s.state} />
        ))}
      </span>
    </Tip>
  );
}
