export interface CaptionStyle {
  id: string;
  label: string;
  description: string;
  fontFamily: string;
  weight: number;
  /** Font size as a fraction of the frame height. */
  size: number;
  color: string;
  /** Colour of the word being spoken (karaoke styles). */
  activeColor?: string;
  /** A rounded box behind the text. */
  background?: string;
  outline?: { color: string; width: number };
  shadow: boolean;
  uppercase: boolean;
  /** Vertical centre of the text block, as a fraction of the frame height. */
  y: number;
  /** Widest a line may be, as a fraction of the frame width. */
  maxWidth: number;
  lineHeight: number;
  /** Highlight the word being spoken. */
  karaoke: boolean;
  /** The active word pops slightly larger as it starts. */
  pop: boolean;
}

const SANS = "Inter, 'Helvetica Neue', Arial, sans-serif";

export const CAPTION_STYLES: CaptionStyle[] = [
  { id: 'default', label: 'Clean', description: 'White text on a soft dark box. Safe everywhere.', fontFamily: SANS, weight: 600, size: 0.045, color: '#ffffff', background: 'rgba(0,0,0,0.62)', shadow: false, uppercase: false, y: 0.88, maxWidth: 0.82, lineHeight: 1.25, karaoke: false, pop: false },
  { id: 'bold-pop', label: 'Bold pop', description: 'Big uppercase with the spoken word highlighted — short-form video style.', fontFamily: SANS, weight: 900, size: 0.07, color: '#ffffff', activeColor: '#ffd23f', outline: { color: '#000000', width: 0.14 }, shadow: true, uppercase: true, y: 0.72, maxWidth: 0.86, lineHeight: 1.15, karaoke: true, pop: true },
  { id: 'minimal', label: 'Minimal', description: 'Small white text with a soft shadow, no box.', fontFamily: SANS, weight: 500, size: 0.04, color: '#ffffff', shadow: true, uppercase: false, y: 0.92, maxWidth: 0.8, lineHeight: 1.3, karaoke: false, pop: false },
  { id: 'boxed', label: 'Boxed', description: 'Bold black text on a white box.', fontFamily: SANS, weight: 800, size: 0.05, color: '#111111', background: 'rgba(255,255,255,0.94)', shadow: false, uppercase: false, y: 0.86, maxWidth: 0.8, lineHeight: 1.25, karaoke: false, pop: false },
  { id: 'karaoke', label: 'Karaoke', description: 'Words light up as they are spoken.', fontFamily: SANS, weight: 800, size: 0.055, color: 'rgba(255,255,255,0.7)', activeColor: '#ffffff', background: 'rgba(0,0,0,0.55)', shadow: false, uppercase: false, y: 0.86, maxWidth: 0.82, lineHeight: 1.25, karaoke: true, pop: false },
];

const byId = new Map(CAPTION_STYLES.map((s) => [s.id, s]));
export const captionStyle = (id: string): CaptionStyle => byId.get(id) ?? CAPTION_STYLES[0]!;
export const hasCaptionStyle = (id: string): boolean => byId.has(id);
