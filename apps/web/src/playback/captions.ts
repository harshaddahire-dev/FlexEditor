import { type CaptionItem, type CaptionStyle, type Ticks, activeWordIndex, captionStyle, captionText } from '@cutroom/core';

export interface CaptionEntry {
  caption: CaptionItem;
  /** Playhead, to find the spoken word. */
  t: Ticks;
}

/** Break words into lines no wider than `maxWidth`, using the context's current font. */
export function wrapWords(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, words: string[], maxWidth: number): number[][] {
  const lines: number[][] = [];
  let cur: number[] = [];
  let width = 0;
  const space = ctx.measureText(' ').width;
  words.forEach((w, i) => {
    const ww = ctx.measureText(w).width;
    if (cur.length && width + space + ww > maxWidth) {
      lines.push(cur);
      cur = [];
      width = 0;
    }
    width += (cur.length ? space : 0) + ww;
    cur.push(i);
  });
  if (cur.length) lines.push(cur);
  return lines;
}

/**
 * Draws burned-in captions on a transparent canvas the size of the sequence: wrapped lines, optional box, outline and
 * shadow, and for karaoke styles the spoken word in the active colour (popping slightly as it starts). The result is
 * uploaded as one more layer, so preview and export show exactly the same text.
 */
export class CaptionPainter {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private lastKey = '';
  version = 0;

  constructor(
    private w: number,
    private h: number,
    private readonly rate: () => number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.lastKey = '';
  }

  /** Repaint for the given captions; returns false (and leaves the canvas alone) when nothing visible changed. */
  paint(entries: readonly CaptionEntry[]): boolean {
    const key = entries.map(({ caption: c, t }) => `${c.id}:${c.styleId}:${captionStyle(c.styleId).karaoke ? activeWordIndex(c, t) : ''}:${captionStyle(c.styleId).pop ? Math.floor((t - c.start) / (this.rate() / 12)) : ''}:${captionText(c)}:${c.position?.x ?? ''},${c.position?.y ?? ''}`).join('|') + `@${this.w}x${this.h}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    for (const e of entries) this.drawOne(e);
    this.version++;
    return true;
  }

  private drawOne({ caption: c, t }: CaptionEntry): void {
    const { ctx, w, h } = this;
    const st: CaptionStyle = captionStyle(c.styleId);
    const size = Math.round(st.size * h);
    ctx.save();
    ctx.font = `${st.weight} ${size}px ${st.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const words = c.words.map((x) => (st.uppercase ? x.text.toUpperCase() : x.text));
    const lines = wrapWords(ctx, words, st.maxWidth * w);
    const lineH = size * st.lineHeight;
    const cx = (c.position?.x ?? 0.5) * w;
    const cy = (c.position?.y ?? st.y) * h;
    const top = cy - (lines.length * lineH) / 2;
    const active = st.karaoke ? activeWordIndex(c, t) : -1;
    const space = ctx.measureText(' ').width;
    const popT = this.rate() / 6; // 1/6 s
    lines.forEach((idxs, li) => {
      const widths = idxs.map((i) => ctx.measureText(words[i]!).width);
      const total = widths.reduce((a, b) => a + b, 0) + space * (idxs.length - 1);
      const y = top + li * lineH + lineH / 2;
      let x = cx - total / 2;
      if (st.background) {
        const padX = size * 0.45;
        const padY = size * 0.12;
        ctx.fillStyle = st.background;
        ctx.beginPath();
        ctx.roundRect(x - padX, y - lineH / 2 + padY, total + padX * 2, lineH - padY * 2, size * 0.28);
        ctx.fill();
      }
      idxs.forEach((i, k) => {
        const word = words[i]!;
        const isActive = i === active;
        const pop = st.pop && isActive ? 1 + 0.14 * Math.max(0, 1 - (t - c.words[i]!.start) / popT) : 1;
        const wx = x + widths[k]! / 2;
        ctx.save();
        ctx.translate(wx, y);
        ctx.scale(pop, pop);
        if (st.shadow) {
          ctx.shadowColor = 'rgba(0,0,0,0.75)';
          ctx.shadowBlur = size * 0.18;
          ctx.shadowOffsetY = size * 0.05;
        }
        ctx.textAlign = 'center';
        if (st.outline) {
          ctx.lineJoin = 'round';
          ctx.lineWidth = size * st.outline.width;
          ctx.strokeStyle = st.outline.color;
          ctx.strokeText(word, 0, 0);
        }
        ctx.fillStyle = st.karaoke ? (isActive || (!st.pop && i < active) ? (st.activeColor ?? st.color) : st.color) : st.color;
        ctx.fillText(word, 0, 0);
        ctx.restore();
        x += widths[k]! + space;
      });
    });
    ctx.restore();
  }
}
