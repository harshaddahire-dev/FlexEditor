import { create } from 'zustand';
import { desktop, type UpdateState } from '../lib/native';

interface UpdatesState {
  state: UpdateState | null;
  /** A restart was refused because work is running; the pill asks before forcing it. */
  confirmBusy: boolean;
  init(): () => void;
  check(): Promise<void>;
  download(): Promise<void>;
  install(force?: boolean): Promise<void>;
  setAuto(on: boolean): Promise<void>;
  dismissBusy(): void;
}

/** Update state of the desktop app; stays null in a browser, where there is nothing to update. */
export const useUpdates = create<UpdatesState>()((set, get) => ({
  state: null,
  confirmBusy: false,
  init: () => {
    const bridge = desktop()?.updates;
    if (!bridge) return () => undefined;
    void bridge.get().then((state) => state && set({ state }));
    return bridge.onState((state) => set({ state }));
  },
  check: async () => {
    const state = await desktop()?.updates.check();
    if (state) set({ state });
  },
  download: async () => void (await desktop()?.updates.download()),
  install: async (force = false) => {
    const r = await desktop()?.updates.install(force);
    if (r && !r.ok && r.reason === 'busy') set({ confirmBusy: true });
    else set({ confirmBusy: false });
  },
  setAuto: async (on) => {
    await desktop()?.updates.setAuto(on);
    const s = get().state;
    if (s) set({ state: { ...s, auto: on } });
  },
  dismissBusy: () => set({ confirmBusy: false }),
}));
