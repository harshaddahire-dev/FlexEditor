import { type CaptionItem, type CaptionStyle, type Sequence, captionStyle, isCaption, itemEnd, trackItems } from '@cutroom/core';

/** `#rrggbb` / `rgba(r,g,b,a)` → ASS `&HAABBGGRR` (alpha is inverted: 00 opaque). */
export function assColor(css: string): string {
  let r = 255;
  let g = 255;
  let b = 255;
  let a = 1;
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(css.trim());
  if (hex) [r, g, b] = [parseInt(hex[1]!.slice(0, 2), 16), parseInt(hex[1]!.slice(2, 4), 16), parseInt(hex[1]!.slice(4, 6), 16)];
  else if (rgba) [r, g, b, a] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  const h = (n: number) => Math.round(n).toString(16).toUpperCase().padStart(2, '0');
  return `&H${h((1 - a) * 255)}${h(b)}${h(g)}${h(r)}`;
}

/** Seconds → ASS `H:MM:SS.cc`. */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, ' ');

function styleLine(st: CaptionStyle, h: number, w: number): string {
  const size = Math.round(st.size * h);
  const box = !!st.background;
  const primary = assColor(st.karaoke && !st.pop ? st.color : st.color);
  const outlineColor = box ? assColor(st.background!) : st.outline ? assColor(st.outline.color) : '&H00000000';
  const outline = box ? Math.round(size * 0.3) : st.outline ? Math.max(1, Math.round(size * st.outline.width)) : 0;
  const shadow = st.shadow ? Math.max(1, Math.round(size * 0.06)) : 0;
  const marginX = Math.round(((1 - st.maxWidth) / 2) * w);
  const family = (st.fontFamily.split(',')[0] ?? 'Arial').replace(/['"]/g, '').trim();
  // Name, Font, Size, Primary, Secondary, Outline, Back, Bold, Italic, Underline, Strike, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  return `Style: ${st.id},${family},${size},${primary},${primary},${outlineColor},&H80000000,${st.weight >= 600 ? -1 : 0},0,0,0,100,100,0,0,${box ? 3 : 1},${outline},${shadow},5,${marginX},${marginX},0,1`;
}

interface Slice {
  from: number;
  to: number;
  active: number;
}

/** The moments a caption's look changes: one slice per spoken word, plus the gaps before, between and after. */
function slices(c: CaptionItem, st: CaptionStyle): Slice[] {
  const end = itemEnd(c);
  if (!st.karaoke || !c.words.length) return [{ from: c.start, to: end, active: -1 }];
  const out: Slice[] = [];
  let t = c.start;
  c.words.forEach((w, i) => {
    const ws = Math.max(t, Math.min(end, w.start));
    const we = Math.max(ws, Math.min(end, w.end));
    if (ws > t) out.push({ from: t, to: ws, active: -1 });
    if (we > ws) out.push({ from: ws, to: we, active: i });
    t = Math.max(t, we);
  });
  if (end > t) out.push({ from: t, to: end, active: -1 });
  return out;
}

function line(c: CaptionItem, st: CaptionStyle, active: number, w: number, h: number): string {
  const act = assColor(st.activeColor ?? st.color);
  const words = c.words.map((x, i) => {
    const text = esc(st.uppercase ? x.text.toUpperCase() : x.text);
    const lit = st.karaoke && (i === active || (!st.pop && active >= 0 && i < active));
    const pop = st.pop && i === active ? '\\fscx114\\fscy114' : '';
    return lit ? `{\\1c${act}${pop}}${text}{\\r}` : text;
  });
  const pos = `{\\an5\\pos(${Math.round((c.position?.x ?? 0.5) * w)},${Math.round((c.position?.y ?? st.y) * h)})}`;
  return pos + words.join(' ');
}

/**
 * Burned-in captions for the FFmpeg engine, as an ASS script timed relative to the range start. The browser engine
 * draws the same captions with the same style table on a canvas; ASS is the closest FFmpeg can get (libass fonts,
 * 10 ms timing), so the two agree on words, timing to a frame and placement, not on every glyph.
 */
export function buildAss(seq: Sequence, fromTicks: number, toTicks: number): string | null {
  const rate = seq.timebase.rate;
  const used = new Map<string, CaptionStyle>();
  const events: string[] = [];
  for (const track of seq.tracks) {
    if (track.kind !== 'caption' || track.muted) continue;
    for (const item of trackItems(track)) {
      if (!isCaption(item) || itemEnd(item) <= fromTicks || item.start >= toTicks) continue;
      const st = captionStyle(item.styleId);
      used.set(st.id, st);
      for (const s of slices(item, st)) {
        const a = Math.max(s.from, fromTicks);
        const b = Math.min(s.to, toTicks);
        if (b <= a) continue;
        events.push(`Dialogue: 0,${assTime((a - fromTicks) / rate)},${assTime((b - fromTicks) / rate)},${st.id},,0,0,0,,${line(item, st, s.active, seq.width, seq.height)}`);
      }
    }
  }
  if (!events.length) return null;
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${seq.width}`,
    `PlayResY: ${seq.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...[...used.values()].map((s) => styleLine(s, seq.height, seq.width)),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
