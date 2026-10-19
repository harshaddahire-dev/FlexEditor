import { create } from 'zustand';
import { type AgentSettings, DEFAULT_AGENT_SETTINGS, type ModelInfo, type ProviderInfo, type ProviderInput, type ProviderTestResult } from '@cutroom/core';
import { api } from '../lib/api';

interface AgentState {
  loaded: boolean;
  providers: ProviderInfo[];
  settings: AgentSettings;
  models: Record<string, { models: ModelInfo[]; error?: string; loading: boolean }>;
  tests: Record<string, ProviderTestResult | 'testing'>;
  /** Tokens in the running conversation (the agent runtime fills this in). */
  contextUsed: number;

  load(): Promise<void>;
  addProvider(input: ProviderInput): Promise<ProviderInfo>;
  updateProvider(id: string, input: Partial<ProviderInput>): Promise<void>;
  removeProvider(id: string): Promise<void>;
  testProvider(id: string): Promise<void>;
  loadModels(id: string, refresh?: boolean): Promise<void>;
  setSettings(patch: Partial<AgentSettings>): Promise<void>;
}

export const useAgent = create<AgentState>()((set, get) => ({
  loaded: false,
  providers: [],
  settings: DEFAULT_AGENT_SETTINGS,
  models: {},
  tests: {},
  contextUsed: 0,

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
}));
