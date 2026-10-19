import type { AnalysisState, Media } from '@cutroom/core';
import { Tip } from './ui';

const STAGES: { key: 'probe' | 'poster' | 'proxy'; label: string }[] = [
  { key: 'probe', label: 'Metadata' },
  { key: 'poster', label: 'Thumbnail' },
  { key: 'proxy', label: 'Edit proxy' },
];

const WORD: Record<AnalysisState, string> = {
  pending: 'pending',
  queued: 'queued',
  running: 'working',
  done: 'ready',
  failed: 'failed',
  skipped: 'not needed',
};

/** One dot per processing stage; hover for the breakdown. */
export function StatusDots({ media, progress }: { media: Media; progress?: number }) {
  const stages = STAGES.filter((s) => media.status[s.key] !== 'skipped');
  const summary = stages
    .map((s) => `${s.label}: ${WORD[media.status[s.key]]}${s.key === 'proxy' && media.status.proxy === 'running' && progress !== undefined ? ` ${Math.round(progress * 100)}%` : ''}`)
    .join(' · ');
  return (
    <Tip label={summary || 'Ready'}>
      <span className="dots" role="img" aria-label={summary || 'Ready'}>
        {stages.map((s) => (
          <i key={s.key} className="dot" data-state={media.status[s.key]} />
        ))}
      </span>
    </Tip>
  );
}
