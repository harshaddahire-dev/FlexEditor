import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'cutroom.layout.';

function read(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

/** A persisted pixel size (panel width / height) clamped to [min, max]. */
export function usePersistedSize(key: string, fallback: number, min: () => number, max: () => number) {
  const clamp = useCallback((n: number) => Math.round(Math.min(max(), Math.max(min(), n))), [min, max]);
  const [size, setSizeState] = useState(() => clamp(read(key, fallback)));
  const setSize = useCallback(
    (n: number) => {
      const v = clamp(n);
      setSizeState(v);
      try {
        localStorage.setItem(PREFIX + key, String(v));
      } catch {
        /* storage unavailable: size just won't persist */
      }
    },
    [clamp, key],
  );
  // Keep within bounds when the window shrinks.
  useEffect(() => {
    const onResize = () => setSizeState((s) => clamp(s));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);
  return [size, setSize] as const;
}

export function readBool(key: string, fallback: boolean): boolean {
  return read(key, fallback ? 1 : 0) === 1;
}

export function writeBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(PREFIX + key, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}
