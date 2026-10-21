import { create } from 'zustand';
import type { WhisperSetup } from '@cutroom/core';
import { api } from '../lib/api';
import { useApp } from './app';

interface WhisperState {
  setup: WhisperSetup | null;
  model: string;
  setModel(id: string): void;
  load(): Promise<void>;
  install(): Promise<void>;
  cancel(): Promise<void>;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Transcription setup: what is installed and the progress of the one-click install (polled while it runs). */
export const useWhisper = create<WhisperState>()((set, get) => {
  const stopPolling = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const poll = () => {
    if (timer) return;
    timer = setInterval(async () => {
      const prev = get().setup?.install.status;
      await get().load();
      const now = get().setup?.install.status;
      if (now !== 'running') {
        stopPolling();
        // installed: the health banner and the transcript stages pick up the new engine
        if (prev === 'running' && now === 'done') void api.health().then((health) => useApp.setState({ health }));
      }
    }, 700);
  };
  return {
    setup: null,
    model: 'base',
    setModel: (model) => set({ model }),
    load: async () => {
      try {
        const setup = await api.whisper();
        set({ setup });
        if (setup.install.status === 'running') poll();
      } catch {
        /* the server is unreachable; the rest of the app says so */
      }
    },
    install: async () => {
      const install = await api.installWhisper(get().model);
      const s = get().setup;
      if (s) set({ setup: { ...s, install } });
      poll();
    },
    cancel: async () => {
      await api.cancelWhisperInstall();
      await get().load();
    },
  };
});
