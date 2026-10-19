import { type Issue, validateSequence } from '@cutroom/core';
import type { AgentHost } from './types';

export interface QaIssue {
  severity: string;
  code: string;
  message: string;
  key: string;
}

const key = (i: Issue): string => `${i.code}:${[...(i.itemIds ?? [])].sort().join(',')}:${i.trackId ?? ''}`;

/** Fingerprints of the problems present right now — taken before a run so QA only blames what the run caused. */
export function baseline(host: AgentHost): Set<string> {
  return new Set(validateSequence(host.sequence(), host.env).map(key));
}

/**
 * The structural audit, minus anything that was already wrong before the agent started. Errors are never expected
 * (the engine refuses them); warnings — flash frames, gaps, audio clicks, desync — are what a rough cut tends to leave.
 */
export function qaCheck(host: AgentHost, before: ReadonlySet<string>): QaIssue[] {
  return validateSequence(host.sequence(), host.env)
    .filter((i) => !before.has(key(i)))
    .map((i) => ({ severity: i.severity, code: i.code, message: i.message, key: key(i) }));
}
