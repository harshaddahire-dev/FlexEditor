import { type Clip, type Op, type Sequence, allClips, captionStyle, isCaption, itemEnd, sequenceDuration, trackItems, validateSequence } from '@cutroom/core';
import { type RunEvent, type RunOptions, runAgent } from '../src';
import { collect, makeHost, scripted, type Turn, type TestHost } from '../test/helpers';
import type { LlmClient } from '../src';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface EvalContext {
  host: TestHost;
  events: RunEvent[];
  summary: string;
  edits: number;
  /** Names of the tools the agent called, in order. */
  tools: string[];
  /** The timeline as it was before the run. */
  before: Sequence;
}

export interface EvalScenario {
  id: string;
  title: string;
  prompt: string;
  mode?: RunOptions['mode'];
  /** Approve (true) or deny each edit in Ask mode. */
  approve?: (tool: string) => boolean;
  /** Put the project in the state the request starts from. */
  setup?: (host: TestHost) => void;
  /** A trajectory a competent agent would take: runs against the real tools to prove the scenario is achievable. */
  script: Turn[] | ((host: TestHost) => Turn[]);
  checks: (c: EvalContext) => Check[];
}

export interface EvalResult {
  id: string;
  title: string;
  passed: boolean;
  checks: Check[];
  tools: string[];
  edits: number;
  steps: number;
  ms: number;
  summary: string;
  error?: string;
}

/* ---- helpers the scenarios share ---- */

export const secs = (seq: Sequence, ticks: number): number => ticks / seq.timebase.rate;

/** Put `media` on V1 (+ linked A1 when it has audio) like a user dropping it on the timeline. */
export function place(host: TestHost, mediaId: string, atSec: number, inSec: number, outSec: number, linked = true): void {
  const seq = host.sequence();
  const R = seq.timebase.rate;
  const v = seq.tracks.find((t) => t.name === 'V1')!.id;
  const a = seq.tracks.find((t) => t.name === 'A1')!.id;
  const clips = [{ trackId: v, mediaId, sourceIn: Math.round(inSec * R), sourceOut: Math.round(outSec * R), ...(linked ? { link: `l${atSec}` } : {}) }, ...(linked ? [{ trackId: a, mediaId, sourceIn: Math.round(inSec * R), sourceOut: Math.round(outSec * R), link: `l${atSec}` }] : [])];
  host.applyOps([{ type: 'overwrite', at: Math.round(atSec * R), clips } as Op], { label: 'setup', origin: 'user', group: 'setup' });
}

export const videoClips = (seq: Sequence): Clip[] =>
  seq.tracks
    .filter((t) => t.kind === 'video')
    .flatMap((t) => trackItems(t).filter((i): i is Clip => i.kind === 'clip'))
    .sort((a, b) => a.start - b.start);

export const audioClips = (seq: Sequence): Clip[] =>
  seq.tracks
    .filter((t) => t.kind === 'audio')
    .flatMap((t) => trackItems(t).filter((i): i is Clip => i.kind === 'clip'))
    .sort((a, b) => a.start - b.start);

/** Is the whole timeline structurally sound (no overlaps, no desync, nothing off the frame grid)? */
export function sound(host: TestHost): Check {
  const errors = validateSequence(host.sequence(), host.env, {}).filter((i) => i.severity === 'error');
  return { name: 'timeline is valid (no overlaps, A/V in sync, frame-aligned)', ok: errors.length === 0, detail: errors.map((e) => e.message).join('; ') || undefined };
}

/** Id of the n-th video clip (by time), for scripted trajectories. */
export const clipId = (host: TestHost, n = 0): string => videoClips(host.sequence())[n]!.id;

export const check = (name: string, ok: boolean, detail?: string): Check => ({ name, ok, ...(detail && !ok ? { detail } : {}) });

export { allClips, captionStyle, isCaption, itemEnd, sequenceDuration, trackItems };

/** Run one scenario against a model (the scripted trajectory, or any client). */
export async function runScenario(s: EvalScenario, model: LlmClient | 'scripted', opts: { maxSteps?: number } = {}): Promise<EvalResult> {
  const t0 = performance.now();
  let inner: LlmClient | null = null;
  const host = makeHost({ stream: (req, signal) => inner!.stream(req, signal) });
  s.setup?.(host);
  inner = model === 'scripted' ? scripted(typeof s.script === 'function' ? s.script(host) : s.script) : model;
  const before = host.sequence();
  const { events, emit } = collect();
  const tools: string[] = [];
  const result = await runAgent(host, {
    runId: s.id,
    prompt: s.prompt,
    mode: s.mode ?? 'auto',
    effort: 'medium',
    model: 'eval',
    maxSteps: opts.maxSteps ?? 30,
    emit: (e) => {
      if (e.type === 'tool_call') tools.push(e.tool);
      emit(e);
    },
    approve: async (req) => (s.approve ? s.approve(req.tool) : true),
  });
  const ctx: EvalContext = { host, events, summary: result.summary, edits: result.edits, tools, before };
  let checks: Check[];
  let error: string | undefined;
  try {
    checks = s.checks(ctx);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    checks = [{ name: 'checks ran', ok: false, detail: error }];
  }
  const failed = events.find((e) => e.type === 'error');
  if (failed && failed.type === 'error') checks.push({ name: 'run did not error', ok: false, detail: failed.message });
  return { id: s.id, title: s.title, passed: checks.every((c) => c.ok), checks, tools, edits: result.edits, steps: tools.length, ms: performance.now() - t0, summary: result.summary, ...(error ? { error } : {}) };
}

export function formatResults(results: EvalResult[]): string {
  const lines = results.map((r) => `${r.passed ? 'PASS' : 'FAIL'}  ${r.id.padEnd(22)} ${r.steps} tool calls · ${r.edits} edits · ${Math.round(r.ms)} ms${r.passed ? '' : '\n' + r.checks.filter((c) => !c.ok).map((c) => `      ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`).join('\n')}`);
  const pass = results.filter((r) => r.passed).length;
  return `${lines.join('\n')}\n\n${pass}/${results.length} scenarios passed`;
}
