/** Model providers and the provider-neutral chat types the agent runtime speaks. */

export type ProviderKind = 'openrouter' | 'openai' | 'anthropic' | 'gemini' | 'custom';

/** How hard the model should think. `off` sends no reasoning parameter at all. */
export type Effort = 'off' | 'low' | 'medium' | 'high' | 'max';
export const EFFORTS: readonly Effort[] = ['off', 'low', 'medium', 'high', 'max'];

/**
 * ask: every edit waits for approval · auto: edits apply and are reviewed afterwards as a diff · full: agents may also
 * run plugins/tools that reach outside the project.
 */
export type AgentMode = 'ask' | 'auto' | 'full';
export const AGENT_MODES: readonly AgentMode[] = ['ask', 'auto', 'full'];

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  /** Where a person gets an API key. */
  keyUrl?: string;
  keyPlaceholder: string;
  /** The base URL is editable (custom endpoints, proxies). */
  editableUrl: boolean;
}

export const PROVIDER_PRESETS: Record<ProviderKind, ProviderPreset> = {
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', keyPlaceholder: 'sk-or-…', editableUrl: false },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', keyPlaceholder: 'sk-…', editableUrl: false },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys', keyPlaceholder: 'sk-ant-…', editableUrl: false },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyUrl: 'https://aistudio.google.com/apikey', keyPlaceholder: 'AIza…', editableUrl: false },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: 'http://localhost:11434/v1', keyPlaceholder: 'optional for local servers', editableUrl: true },
};

/** What the browser may know about a provider — never the key itself. */
export interface ProviderInfo {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  /** Last four characters of the key, for recognition only. */
  keyHint?: string;
  defaultModel?: string;
  createdAt: number;
}

export interface ProviderInput {
  kind: ProviderKind;
  name?: string;
  baseUrl?: string;
  /** Write-only. Omitted on update = keep the stored key; empty string = remove it. */
  apiKey?: string;
  defaultModel?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** Tokens, when known (provider metadata, else the curated table, else null). */
  contextWindow: number | null;
}

export interface AgentSettings {
  providerId?: string;
  model?: string;
  effort: Effort;
  mode: AgentMode;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { effort: 'medium', mode: 'ask' };

export interface ProviderTestResult {
  ok: boolean;
  models: number;
  error?: string;
}

/* ---------- provider-neutral chat ---------- */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant: calls it made. */
  toolCalls?: ToolCall[];
  /** tool: which call this answers. */
  toolCallId?: string;
  /** tool: the tool's name (Gemini needs it). */
  name?: string;
  /** Opaque provider data from the assistant turn that must be sent back verbatim (reasoning signatures). */
  providerData?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object schema). */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  effort?: Effort;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: ChatUsage;
  stopReason: 'stop' | 'tool_calls' | 'length' | 'other';
  /** Echo this on the assistant ChatMessage built from the result (see ChatMessage.providerData). */
  providerData?: unknown;
}

export type ChatEvent = { type: 'text'; delta: string } | { type: 'thinking'; delta: string } | { type: 'done'; result: ChatResult };

/* ---------- context window ---------- */

/** Known context windows (tokens), matched by model-id prefix/substring; used when a provider's list gives none. */
const CONTEXT_TABLE: [RegExp, number][] = [
  [/claude-(opus|sonnet|haiku|fable)/i, 200_000],
  [/claude/i, 200_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-5/i, 400_000],
  [/gpt-4o|o1|o3|o4/i, 128_000],
  [/gemini-(1\.5|2|3)/i, 1_000_000],
  [/llama-?3/i, 128_000],
  [/mistral|mixtral/i, 32_000],
  [/qwen/i, 128_000],
  [/deepseek/i, 64_000],
];

export function contextWindowFor(modelId: string): number | null {
  for (const [re, n] of CONTEXT_TABLE) if (re.test(modelId)) return n;
  return null;
}

/** Rough token count (≈ 4 characters per token plus per-message overhead) for the context meter. */
export function estimateTokens(messages: readonly ChatMessage[], tools: readonly ToolSpec[] = []): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + 16;
    for (const c of m.toolCalls ?? []) chars += c.name.length + JSON.stringify(c.arguments).length;
  }
  for (const t of tools) chars += t.name.length + t.description.length + JSON.stringify(t.parameters).length;
  return Math.ceil(chars / 4);
}
