import type { ExternalTool, PluginContext, Skill } from '@cutroom/plugin-sdk';
import type { AgentMode, AgentRole, ApprovalRequest, ChatEvent, ChatMessage, ChatRequest, EditEnv, Effort, Media, Op, RunEvent, Sequence, ToolScope } from '@cutroom/core';

export type Role = AgentRole;

export type AnalysisKind = 'transcript' | 'silences' | 'scenes' | 'beats' | 'loudness';

/** The model, as the runtime sees it: a stream of events for one request. */
export interface LlmClient {
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
}

/** A rejected edit, with the operation index and a reason the model can act on. */
export class HostEditError extends Error {
  constructor(
    message: string,
    readonly code = 'edit_invalid',
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HostEditError';
  }
}

/** Everything the agents may touch. The server implements this on top of the same EditSession the UI uses. */
export interface AgentHost {
  llm: LlmClient;
  /** Committed sequence. */
  sequence(): Sequence;
  media(): Media[];
  env: EditEnv;
  /** Apply ONE atomic transaction (all ops or none). Throws HostEditError. */
  applyOps(ops: Op[], opts: { label: string; origin: string; group: string }): { revision: number };
  /** Cached analysis (transcript, silences, scenes, beats, loudness) or null when it does not exist (yet). */
  analysis(mediaId: string, kind: AnalysisKind): Promise<unknown | null>;
  /** Skills the agents may load (SKILL.md files and plugin skills). */
  skills?(): Skill[];
  /** Tools from plugins and MCP servers. Only offered to the Director in Full access mode. */
  externalTools?(): ExternalTool[];
  log?(message: string): void;
}

export interface ToolCtx {
  host: AgentHost;
  role: Role;
  /** Groups every edit of this run so it can be undone as one. */
  group: string;
  /** Edit tools record here so the runtime can tell whether anything changed. */
  onEdit(revision: number): void;
}

export type { ToolScope, ExternalTool, PluginContext, Skill };

/** `ok:false` results go back to the model as the tool's answer so it can correct itself. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export type { ApprovalRequest, RunEvent };
/** true/false for this edit; 'always' also approves the rest of the run. */
export type Approval = boolean | 'always';

export interface RunOptions {
  runId: string;
  prompt: string;
  /** Earlier turns of this conversation (user/assistant text only). */
  history?: ChatMessage[];
  mode: AgentMode;
  effort: Effort;
  model: string;
  maxSteps?: number;
  signal?: AbortSignal;
  emit(e: RunEvent): void;
  approve(req: ApprovalRequest): Promise<Approval>;
}

export interface RunResult {
  summary: string;
  group: string;
  edits: number;
  cancelled: boolean;
  messages: ChatMessage[];
}
