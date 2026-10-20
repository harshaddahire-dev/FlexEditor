import type { AgentRole, RunEvent } from '@cutroom/core';

export const ROLE_LABEL: Record<AgentRole, string> = { director: 'Director', cutter: 'Cutter', audio: 'Audio', captioner: 'Captioner', motion: 'Motion', finisher: 'Finisher', qa: 'QA' };

const TOOL_LABEL: Record<string, string> = {
  get_overview: 'Looked at the project',
  list_media: 'Listed the media',
  get_sequence: 'Read the timeline',
  get_transcript: 'Read the transcript',
  get_words: 'Read word timings',
  search_transcript: 'Searched the transcript',
  get_silences: 'Found silences',
  get_scenes: 'Found shot changes',
  get_beats: 'Found the beat',
  get_loudness: 'Measured loudness',
  validate: 'Checked the timeline',
  add_clip: 'Added a clip',
  split: 'Split a clip',
  trim: 'Trimmed a clip',
  delete_clips: 'Deleted clips',
  remove_range: 'Removed a section',
  move_clips: 'Moved clips',
  set_speed: 'Changed speed',
  set_clip: 'Changed clip settings',
  set_track: 'Changed a track',
  add_marker: 'Added a marker',
  add_keyframes: 'Added keyframes',
  list_skills: 'Looked up skills',
  use_skill: 'Loaded a skill',
  delegate: 'Asked a specialist',
};

/** `mcp_<server>__<tool>` / `plugin_<id>__<tool>` → "Server · tool". */
function externalLabel(tool: string): string | null {
  const m = /^(mcp|plugin)_(.+?)__(.+)$/.exec(tool);
  return m ? `${m[2]!.replace(/[-_]/g, ' ')} · ${m[3]!.replace(/_/g, ' ')}` : null;
}

export const toolLabel = (tool: string): string => TOOL_LABEL[tool] ?? externalLabel(tool) ?? tool.replace(/_/g, ' ');

/** One step of the transcript the chat renders: a tool call paired with its result (and any approval it waited for). */
export type Step =
  | { kind: 'text'; role: AgentRole; text: string }
  | { kind: 'thinking'; role: AgentRole; text: string }
  | { kind: 'tool'; id: string; role: AgentRole; tool: string; args: unknown; scope: 'read' | 'edit'; result?: { ok: boolean; summary: string; data?: unknown }; awaiting?: boolean }
  | { kind: 'qa'; round: number; issues: { severity: string; code: string; message: string }[] }
  | { kind: 'error'; message: string };

export function stepsOf(events: readonly RunEvent[], pendingId?: string): Step[] {
  const steps: Step[] = [];
  const tools = new Map<string, Extract<Step, { kind: 'tool' }>>();
  for (const e of events) {
    switch (e.type) {
      case 'text':
      case 'thinking':
        if (e.delta) steps.push({ kind: e.type, role: e.role, text: e.delta });
        break;
      case 'tool_call': {
        const s: Extract<Step, { kind: 'tool' }> = { kind: 'tool', id: e.id, role: e.role, tool: e.tool, args: e.args, scope: e.scope };
        tools.set(e.id, s);
        steps.push(s);
        break;
      }
      case 'tool_result': {
        const s = tools.get(e.id);
        if (s) s.result = { ok: e.ok, summary: e.summary, data: e.data };
        break;
      }
      case 'qa':
        steps.push({ kind: 'qa', round: e.round, issues: e.issues });
        break;
      case 'error':
        steps.push({ kind: 'error', message: e.message });
        break;
      default:
        break;
    }
  }
  if (pendingId) {
    const s = tools.get(pendingId);
    if (s) s.awaiting = true;
  }
  return steps;
}

/** Group consecutive read-only steps so a long investigation collapses into one line. */
export function arrange(steps: Step[]): (Step | { kind: 'reads'; steps: Extract<Step, { kind: 'tool' }>[] })[] {
  const out: (Step | { kind: 'reads'; steps: Extract<Step, { kind: 'tool' }>[] })[] = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (s.kind === 'tool' && s.scope === 'read') {
      if (last && last.kind === 'reads') last.steps.push(s);
      else out.push({ kind: 'reads', steps: [s] });
    } else out.push(s);
  }
  return out;
}
