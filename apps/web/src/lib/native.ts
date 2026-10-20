/** What the desktop app (Electron) adds to the page; absent in a normal browser. */
export interface DesktopBridge {
  platform: string;
  /** Native folder dialog; null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Reveal a file or folder in Explorer / Finder. */
  reveal(path: string): Promise<void>;
}

export const desktop = (): DesktopBridge | null => (window as unknown as { cutroomDesktop?: DesktopBridge }).cutroomDesktop ?? null;
