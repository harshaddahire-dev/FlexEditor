import type { ServerEvent } from '@cutroom/core';

export interface SocketHandle {
  close(): void;
}

/** WebSocket with automatic reconnect (capped exponential backoff). `onOpen` fires on every (re)connect so callers can resync. */
export function connectSocket(
  onEvent: (e: ServerEvent) => void,
  onStatus: (connected: boolean) => void,
): SocketHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      attempt = 0;
      onStatus(true);
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)) as ServerEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (closed) return;
      timer = setTimeout(open, Math.min(5000, 250 * 2 ** attempt++));
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
