import { create } from 'zustand';
import { readBool, writeBool } from '../lib/layout';

export type Workspace = 'edit' | 'audio' | 'captions' | 'color';
export type LeftTab = 'media' | 'transcript' | 'captions' | 'effects' | 'transitions' | 'skills';
export type Theme = 'dark' | 'light';

const WORKSPACE_TAB: Record<Workspace, LeftTab> = { edit: 'media', audio: 'media', captions: 'captions', color: 'effects' };

function readTheme(): Theme {
  try {
    return localStorage.getItem('cutroom.theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

interface UiState {
  workspace: Workspace;
  leftTab: LeftTab;
  rightOpen: boolean;
  settingsOpen: boolean;
  settingsTab: 'project' | 'system';
  theme: Theme;
  setWorkspace(w: Workspace): void;
  setLeftTab(t: LeftTab): void;
  toggleRight(): void;
  openSettings(tab?: 'project' | 'system'): void;
  closeSettings(): void;
  setTheme(t: Theme): void;
}

export const useUi = create<UiState>()((set, get) => ({
  workspace: 'edit',
  leftTab: 'media',
  rightOpen: readBool('rightOpen', true),
  settingsOpen: false,
  settingsTab: 'project',
  theme: readTheme(),
  setWorkspace: (workspace) => set({ workspace, leftTab: WORKSPACE_TAB[workspace] }),
  setLeftTab: (leftTab) => set({ leftTab }),
  toggleRight: () => {
    const rightOpen = !get().rightOpen;
    writeBool('rightOpen', rightOpen);
    set({ rightOpen });
  },
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? get().settingsTab }),
  closeSettings: () => set({ settingsOpen: false }),
  setTheme: (theme) => {
    try {
      localStorage.setItem('cutroom.theme', theme);
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
}));
