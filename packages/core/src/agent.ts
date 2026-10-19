import type { SequenceDiff } from './edit/diff';

export type AgentRole = 'director' | 'cutter' | 'audio' | 'captioner' | 'motion' | 'finisher' | 'qa';

export type ToolScope = 'read' | 'edit';

export type ApprovalRequest = { id: string; role: AgentRole; tool: string; args: unknown; summary: string };

/** What a run emits as it works — streamed to the browser and stored in the chat transcript. */
export type RunEvent =
  | { type: 'run_start'; runId: string; role: AgentRole; prompt: string }
  | { type: 'text'; role: AgentRole; delta: string }
  | { type: 'thinking'; role: AgentRole; delta: string }
  | { type: 'tool_call'; id: string; role: AgentRole; tool: string; args: unknown; scope: ToolScope }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'tool_result'; id: string; role: AgentRole; tool: string; ok: boolean; summary: string; data?: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number; contextTokens: number }
  | { type: 'qa'; round: number; issues: { severity: string; code: string; message: string }[] }
  | { type: 'done'; runId: string; summary: string; group: string; edits: number; cancelled: boolean; revisionFrom: number | null; revisionTo: number | null }
  | { type: 'error'; message: string };

/** How the user has dealt with an agent run's edits. */
export type ReviewState = 'pending' | 'accepted' | 'undone' | 'dismissed';

export interface ChatTurn {
  runId: string;
  prompt: string;
  at: number;
  status: 'running' | 'done' | 'cancelled' | 'error';
  events: RunEvent[];
  summary?: string;
  /** Transaction group of this run's edits (undo them together). */
  group?: string;
  edits: number;
  /** What the run changed on the timeline. */
  diff?: SequenceDiff;
  review: ReviewState;
  model?: string;
  /** A request waiting for the user's approval, if any (Ask mode). */
  pending?: ApprovalRequest;
}

export interface ChatState {
  turns: ChatTurn[];
  /** The run in progress, if any. */
  activeRunId?: string;
}

/** Collapse streaming deltas so a stored turn is a readable transcript, not thousands of tiny events. */
export function compactEvents(events: readonly RunEvent[]): RunEvent[] {
  const out: RunEvent[] = [];
  let lastUsage: RunEvent | null = null;
  for (const e of events) {
    if (e.type === 'usage') {
      lastUsage = e;
      continue;
    }
    const prev = out[out.length - 1];
    if ((e.type === 'text' || e.type === 'thinking') && prev && prev.type === e.type && prev.role === e.role) {
      prev.delta += e.delta;
      continue;
    }
    out.push(e.type === 'text' || e.type === 'thinking' ? { ...e } : e);
  }
  if (lastUsage) out.push(lastUsage);
  return out;
}
