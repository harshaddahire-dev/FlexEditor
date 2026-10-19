import type { JobInfo, Media, ProjectSummary, ScanReport, ServerEvent } from '@cutroom/core';

/** The slice of app state that server events mutate. Kept separate so the reducer is a pure, testable function. */
export interface LiveState {
  project: ProjectSummary | null;
  media: Record<string, Media>;
  jobs: Record<string, JobInfo>;
  selectedMediaId: string | null;
  lastScan: ScanReport | null;
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
      if (e.project === null) return { project: null, media: {}, selectedMediaId: null, lastScan: null };
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
  }
}
