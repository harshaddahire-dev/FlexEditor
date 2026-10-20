import { create } from 'zustand';
import type { ExtensionsInfo, McpServerInfo, McpServerInput } from '@cutroom/core';
import { api } from '../lib/api';

interface ExtensionsState {
  info: ExtensionsInfo | null;
  error: string | null;
  loading: boolean;
  load(): Promise<void>;
  reload(): Promise<void>;
  setSkill(name: string, enabled: boolean): Promise<void>;
  setPlugin(id: string, enabled: boolean): Promise<void>;
  saveMcp(input: McpServerInput, id?: string): Promise<McpServerInfo>;
  setMcp(id: string, enabled: boolean): Promise<void>;
  testMcp(id: string): Promise<void>;
  removeMcp(id: string): Promise<void>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useExtensions = create<ExtensionsState>()((set, get) => {
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      set({ error: null });
      await fn();
    } catch (e) {
      set({ error: msg(e) });
    }
  };
  const refresh = async () => set({ info: await api.extensions() });
  return {
    info: null,
    error: null,
    loading: false,
    load: () => guard(async () => void (await refresh())),
    reload: () =>
      guard(async () => {
        set({ loading: true });
        try {
          set({ info: await api.reloadExtensions() });
        } finally {
          set({ loading: false });
        }
      }),
    // switches flip at once; the server's answer replaces the guess (or restores it on failure)
    setSkill: (name, enabled) => {
      const info = get().info;
      if (info) set({ info: { ...info, skills: info.skills.map((s) => (s.name === name ? { ...s, enabled } : s)) } });
      return guard(async () => set({ info: await api.setSkillEnabled(name, enabled) })).then(() => { if (get().error) void get().load(); });
    },
    setPlugin: (id, enabled) => {
      const info = get().info;
      if (info) set({ info: { ...info, plugins: info.plugins.map((p) => (p.id === id ? { ...p, enabled } : p)) } });
      return guard(async () => set({ info: await api.setPluginEnabled(id, enabled) })).then(() => { if (get().error) void get().load(); });
    },
    async saveMcp(input, id) {
      const r = await api.saveMcp(input, id);
      await refresh();
      // connecting takes a moment: look again shortly
      setTimeout(() => void get().load(), 1500);
      return r;
    },
    setMcp: (id, enabled) => {
      const info = get().info;
      if (info) set({ info: { ...info, mcp: info.mcp.map((m) => (m.id === id ? { ...m, enabled } : m)) } });
      return guard(async () => { await api.setMcpEnabled(id, enabled); await refresh(); setTimeout(() => void get().load(), 1500); });
    },
    testMcp: (id) => guard(async () => { await api.testMcp(id); await refresh(); }),
    removeMcp: (id) => guard(async () => { await api.removeMcp(id); await refresh(); }),
  };
});
