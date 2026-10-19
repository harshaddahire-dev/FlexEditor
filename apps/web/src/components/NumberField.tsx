import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  value: number;
  onCommit(v: number): void;
  /** Value restored by double-clicking the label. */
  reset?: number;
  min?: number;
  max?: number;
  /** Amount per pixel dragged on the label (and per arrow key). */
  step?: number;
  decimals?: number;
  unit?: string;
}

const clamp = (v: number, min?: number, max?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/**
 * Editor-style numeric field: type a value, use ↑/↓ (Shift ×10), or drag the label sideways to scrub. The edit is
 * committed once — on Enter, blur or pointer release — so it is a single undo step. Double-click the label to reset.
 */
export function NumberField({ label, value, onCommit, reset, min, max, step = 1, decimals = 0, unit }: Props) {
  const [text, setText] = useState(value.toFixed(decimals));
  const editing = useRef(false);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (!editing.current && !drag.current) setText(value.toFixed(decimals));
  }, [value, decimals]);

  const commit = (v: number) => {
    const next = clamp(Number.isFinite(v) ? v : value, min, max);
    setText(next.toFixed(decimals));
    if (Math.abs(next - value) > 1e-9) onCommit(next);
  };

  return (
    <label className="nf">
      <span
        className="nf__label"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, v: value, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          if (Math.abs(dx) > 2) d.moved = true;
          if (d.moved) setText(clamp(d.v + dx * step * (e.shiftKey ? 10 : 1), min, max).toFixed(decimals));
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved) commit(Number(text));
        }}
        onDoubleClick={() => reset !== undefined && commit(reset)}
        title={reset !== undefined ? 'Drag to scrub · double-click to reset' : 'Drag to scrub'}
      >
        {label}
      </span>
      <input
        className="nf__input"
        inputMode="decimal"
        aria-label={label}
        value={text}
        spellCheck={false}
        onFocus={(e) => {
          editing.current = true;
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          editing.current = false;
          commit(Number(text));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            setText(value.toFixed(decimals));
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const dir = e.key === 'ArrowUp' ? 1 : -1;
            const next = clamp(Number(text) + dir * step * (e.shiftKey ? 10 : 1) * (step < 1 ? 1 : 1), min, max);
            setText(next.toFixed(decimals));
            commit(next);
          }
        }}
      />
      {unit ? <span className="nf__unit">{unit}</span> : null}
    </label>
  );
}
