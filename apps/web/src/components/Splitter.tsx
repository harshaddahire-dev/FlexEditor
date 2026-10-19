import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

interface Props {
  /** `v` is a vertical bar (resizes width); `h` is a horizontal bar (resizes height). */
  orientation: 'v' | 'h';
  value: number;
  onChange: (n: number) => void;
  /** Dragging toward the start (left/up) grows the value — for right-hand and bottom panels. */
  invert?: boolean;
  label: string;
  style?: React.CSSProperties;
}

export function Splitter({ orientation, value, onChange, invert, label, style }: Props) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const axis = orientation === 'v' ? 'clientX' : 'clientY';
  const sign = invert ? -1 : 1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { pos: e[axis], value };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onChange(start.current.value + sign * (e[axis] - start.current.pos));
  };
  const end = () => {
    start.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const grow = orientation === 'v' ? 'ArrowRight' : 'ArrowDown';
    const shrink = orientation === 'v' ? 'ArrowLeft' : 'ArrowUp';
    if (e.key === grow) onChange(value + sign * step);
    else if (e.key === shrink) onChange(value - sign * step);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`splitter splitter--${orientation}`}
      role="separator"
      aria-orientation={orientation === 'v' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      data-dragging={dragging}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
