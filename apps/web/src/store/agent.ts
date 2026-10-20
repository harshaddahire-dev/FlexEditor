import { create } from 'zustand';
import { type AgentSettings, type ChatTurn, DEFAULT_AGENT_SETTINGS, type ModelInfo, type ProviderInfo, type ProviderInput, type ProviderTestResult, type RunEvent, type ServerEvent } from '@cutroom/core';
import { api } from '../lib/api';

interface AgentState {
  loaded: boolean;
  providers: ProviderInfo[];
  settings: AgentSettings;
  models: Record<string, { models: ModelInfo[]; error?: string; loading: boolean }>;
  tests: Record<string, ProviderTestResult | 'testing'>;
  /** Tokens in the running conversation (from the model's own usage reports). */
  contextUsed: number;
  turns: ChatTurn[];
  activeRunId: string | null;
  sendError: string | null;
  /** Draw removed/moved items of the run under review on the timeline. */
  showGhosts: boolean;
  toggleGhosts(): void;

  load(): Promise<void>;
  addProvider(input: ProviderInput): Promise<ProviderInfo>;
  updateProvider(id: string, input: Partial<ProviderInput>): Promise<void>;
  removeProvider(id: string): Promise<void>;
  testProvider(id: string): Promise<void>;
  loadModels(id: string, refresh?: boolean): Promise<void>;
  setSettings(patch: Partial<AgentSettings>): Promise<void>;

  loadChat(): Promise<void>;
  send(prompt: string): Promise<boolean>;
  decide(runId: string, requestId: string, decision: 'approve' | 'deny' | 'always'): Promise<void>;
  stop(): Promise<void>;
  review(runId: string, action: 'accept' | 'undo' | 'dismiss'): Promise<string | null>;
  clearChat(): Promise<void>;
  onServerEvent(e: Extract<ServerEvent, { type: 'agent' }>): void;
}

/** Streaming text arrives in tiny deltas: fold each into the previous block of the same kind. */
function pushEvent(events: RunEvent[], e: RunEvent): RunEvent[] {
  const prev = events[events.length - 1];
  if ((e.type === 'text' || e.type === 'thinking') && prev && prev.type === e.type && prev.role === e.role) return [...events.slice(0, -1), { ...prev, delta: prev.delta + e.delta }];
  if (e.type === 'usage') return [...events.filter((x) => x.type !== 'usage'), e];
  return [...events, e];
}

export const useAgent = create<AgentState>()((set, get) => ({
  loaded: false,
  providers: [],
  settings: DEFAULT_AGENT_SETTINGS,
  models: {},
  tests: {},
  contextUsed: 0,
  turns: [],
  activeRunId: null,
  sendError: null,
  showGhosts: true,
  toggleGhosts: () => set((s) => ({ showGhosts: !s.showGhosts })),

  async load() {
    const r = await api.providers();
    set({ providers: r.providers, settings: r.agent, loaded: true });
  },

  async addProvider(input) {
    const p = await api.addProvider(input);
    set((s) => ({ providers: [...s.providers, p] }));
    // the first provider becomes the agent's provider, so a fresh install works without another step
    if (!get().settings.providerId) await get().setSettings({ providerId: p.id, model: p.defaultModel });
    return p;
  },

  async updateProvider(id, input) {
    const p = await api.updateProvider(id, input);
    set((s) => ({ providers: s.providers.map((x) => (x.id === id ? p : x)), models: { ...s.models, [id]: undefined as never } }));
  },

  async removeProvider(id) {
    await api.removeProvider(id);
    set((s) => ({ providers: s.providers.filter((x) => x.id !== id), settings: s.settings.providerId === id ? { ...s.settings, providerId: undefined, model: undefined } : s.settings }));
  },

  async testProvider(id) {
    set((s) => ({ tests: { ...s.tests, [id]: 'testing' } }));
    try {
      const r = await api.testProvider(id);
      set((s) => ({ tests: { ...s.tests, [id]: r } }));
    } catch (e) {
      set((s) => ({ tests: { ...s.tests, [id]: { ok: false, models: 0, error: e instanceof Error ? e.message : String(e) } } }));
    }
  },

  async loadModels(id, refresh = false) {
    if (!refresh && get().models[id]?.models.length) return;
    set((s) => ({ models: { ...s.models, [id]: { models: s.models[id]?.models ?? [], loading: true } } }));
    try {
      const r = await api.providerModels(id, refresh);
      set((s) => ({ models: { ...s.models, [id]: { models: r.models, error: r.error, loading: false } } }));
    } catch (e) {
      set((s) => ({ models: { ...s.models, [id]: { models: [], error: e instanceof Error ? e.message : String(e), loading: false } } }));
    }
  },

  async setSettings(patch) {
    const next = { ...get().settings, ...patch };
    // changing provider invalidates the model unless one is given
    if (patch.providerId !== undefined && patch.providerId !== get().settings.providerId && patch.model === undefined) next.model = undefined;
    set({ settings: next });
    set({ settings: await api.setAgentSettings(next) });
  },

  async loadChat() {
    const c = await api.agentChat();
    const last = c.turns[c.turns.length - 1];
    const usage = last?.events.filter((e) => e.type === 'usage').at(-1);
    set({ turns: c.turns, activeRunId: c.activeRunId ?? null, contextUsed: usage?.type === 'usage' ? usage.contextTokens : 0 });
  },

  async send(prompt) {
    set({ sendError: null });
    try {
      const { runId } = await api.startRun(prompt);
      set({ activeRunId: runId });
      return true;
    } catch (e) {
      set({ sendError: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  async decide(runId, requestId, decision) {
    await api.approveRun(runId, requestId, decision);
  },

  async stop() {
    const id = get().activeRunId;
    if (id) await api.cancelRun(id).catch(() => undefined);
  },

  async review(runId, action) {
    try {
      const t = await api.reviewRun(runId, action);
      set((s) => ({ turns: s.turns.map((x) => (x.runId === runId ? t : x)) }));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },

  async clearChat() {
    await api.clearAgentChat();
    set({ turns: [], contextUsed: 0 });
  },

  onServerEvent(e) {
    if (e.kind === 'turn') {
      set((s) => {
        const i = s.turns.findIndex((t) => t.runId === e.turn.runId);
        // keep the richer live event list while a run streams; the server's copy is compacted
        const turns = i < 0 ? [...s.turns, e.turn] : s.turns.map((t, k) => (k === i ? { ...e.turn, events: e.turn.status === 'running' ? t.events : e.turn.events } : t));
        return { turns, activeRunId: e.turn.status === 'running' ? e.turn.runId : s.activeRunId === e.turn.runId ? null : s.activeRunId };
      });
      return;
    }
    set((s) => ({
      turns: s.turns.map((t) => (t.runId === e.runId ? { ...t, events: pushEvent(t.events, e.event) } : t)),
      contextUsed: e.event.type === 'usage' ? e.event.contextTokens : s.contextUsed,
    }));
  },
}));

/** The diff of the latest agent run that is still waiting for the user's decision (null when nothing is under review). */
export function reviewDiff() {
  const { turns, showGhosts } = useAgent.getState();
  if (!showGhosts) return null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.review === 'pending' && t.diff && t.status !== 'running') return t.diff;
  }
  return null;
}
