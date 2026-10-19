import { applyPatches, type HistoryState, type JobInfo, type Media, type Patch, type ProjectSummary, type ScanReport, type Sequence, type ServerEvent } from '@cutroom/core';

/** The slice of app state that server events mutate. Kept separate so the reducer is a pure, testable function. */
export interface LiveState {
  project: ProjectSummary | null;
  media: Record<string, Media>;
  jobs: Record<string, JobInfo>;
  selectedMediaId: string | null;
  lastScan: ScanReport | null;
  /** Mirror of the server's sequence, kept current by applying streamed patches. */
  sequence: Sequence | null;
  revision: number;
  /** A patch arrived out of order: the mirror can no longer be trusted until it is refetched. */
  sequenceStale: boolean;
  history: HistoryState | null;
}

const MAX_JOBS = 100;

function pruneJobs(jobs: Record<string, JobInfo>): Record<string, JobInfo> {
  const all = Object.values(jobs);
  if (all.length <= MAX_JOBS) return jobs;
  const finished = all.filter((j) => j.finishedAt).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  const drop = new Set(finished.slice(0, all.length - MAX_JOBS).map((j) => j.id));
  return Object.fromEntries(Object.entries(jobs).filter(([id]) => !drop.has(id)));
}

export function applyServerEvent(s: LiveState, e: ServerEvent): Partial<LiveState> {
  switch (e.type) {
    case 'hello':
      return { jobs: Object.fromEntries(e.jobs.map((j) => [j.id, j])), project: e.project };
    case 'project':
      if (e.project === null) return { project: null, media: {}, selectedMediaId: null, lastScan: null, sequence: null, revision: 0, sequenceStale: false, history: null };
      return { project: e.project };
    case 'job':
      return { jobs: pruneJobs({ ...s.jobs, [e.job.id]: e.job }) };
    case 'media':
      // Ignore stragglers that arrive after the project was closed.
      return s.project ? { media: { ...s.media, [e.media.id]: e.media } } : {};
    case 'mediaRemoved': {
      const { [e.mediaId]: _gone, ...rest } = s.media;
      return { media: rest, selectedMediaId: s.selectedMediaId === e.mediaId ? null : s.selectedMediaId };
    }
    case 'scan':
      return { lastScan: e.report };
    case 'history':
      return { history: e.history };
    case 'sequence': {
      if (e.kind === 'load') return e.sequence ? { sequence: e.sequence, revision: e.revision, sequenceStale: false } : { sequenceStale: true };
      // Every commit/undo/redo moves the revision by exactly one. Anything else means we missed an event.
      if (!s.sequence || e.revision !== s.revision + 1) return { sequenceStale: true };
      return { sequence: applyPatches(s.sequence, e.patches as Patch[]), revision: e.revision };
    }
    case 'agent':
      return {}; // streamed into the agent store, not the project mirror
  }
}
