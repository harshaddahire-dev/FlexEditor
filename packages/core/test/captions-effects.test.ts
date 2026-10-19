import { describe, expect, it } from 'vitest';
import { EFFECTS, TRANSITIONS, CAPTION_STYLES, captionStyle, captionsForClip, captionsToSubtitles, clampParam, defaultParams, effectDef, makeTimebase, resolveEffectParams, transitionDef, validateEffect, activeWordIndex } from '../src';
import { buildClip } from '../src/edit/sequence';

const tb = makeTimebase({ num: 30, den: 1 });
const F = tb.rate / 30;
const w = (text: string, s: number, e: number) => ({ text, startMs: s * 1000, endMs: e * 1000 });
const clip = (o: Partial<Parameters<typeof buildClip>[1]> = {}) => buildClip('c', { mediaId: 'm', trackId: 't', start: 0, duration: 60 * tb.rate, sourceIn: 0, ...o });

const SPEECH = [w('Hello', 1.0, 1.4), w('there,', 1.4, 1.9), w('this', 2.0, 2.2), w('is', 2.2, 2.4), w('a', 2.4, 2.5), w('test.', 2.5, 3.0), w('Second', 6.0, 6.4), w('sentence', 6.4, 7.0), w('here.', 7.0, 7.5)];

describe('effects registry', () => {
  it('has unique types, sane parameter ranges and defaults inside them', () => {
    expect(new Set(EFFECTS.map((e) => e.type)).size).toBe(EFFECTS.length);
    for (const e of EFFECTS) {
      expect(e.params.length).toBeGreaterThan(0);
      for (const p of e.params) {
        expect(p.min).toBeLessThan(p.max);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
        if (p.kind === 'choice') expect(p.options!.length).toBe(p.max - p.min + 1);
      }
    }
    expect(defaultParams('color')).toEqual({ exposure: 0, brightness: 0, contrast: 0, saturation: 1, temperature: 0, tint: 0 });
    expect(effectDef('nope')).toBeUndefined();
  });

  it('validates requests with helpful messages', () => {
    expect(validateEffect('blur', { radius: 10 })).toBeNull();
    expect(validateEffect('blur', { radius: 999 })).toMatch(/between 0 and 60/);
    expect(validateEffect('blur', { sigma: 1 })).toMatch(/no parameter "sigma"/);
    expect(validateEffect('glow')).toMatch(/Unknown effect "glow"/);
    expect(validateEffect('blur', { radius: 'x' })).toMatch(/must be a number/);
  });

  it('animates parameters through effect:<id>.<key> keyframes, clamped to range', () => {
    const c = clip({ keyframes: { 'effect:e1.radius': [{ time: 0, value: 0, interpolation: 'linear' }, { time: 100, value: 200, interpolation: 'linear' }] } });
    const fx = { id: 'e1', type: 'blur', enabled: true, params: { radius: 8 } };
    expect(resolveEffectParams(fx, c, 0).radius).toBe(0);
    expect(resolveEffectParams(fx, c, 25).radius).toBeCloseTo(50, 6);
    expect(resolveEffectParams(fx, c, 100).radius).toBe(60); // clamped
    expect(resolveEffectParams({ ...fx, id: 'e2' }, c, 50).radius).toBe(8); // un-animated: the stored value
    expect(clampParam(effectDef('look')!.params[0]!, 2.6)).toBe(3);
  });
});

describe('transitions registry', () => {
  it('every transition defines transition(uv) and has a positive default length', () => {
    expect(new Set(TRANSITIONS.map((t) => t.type)).size).toBe(TRANSITIONS.length);
    for (const t of TRANSITIONS) {
      expect(t.glsl).toMatch(/vec4 transition\(vec2 uv\)/);
      expect(t.duration).toBeGreaterThan(0);
    }
    expect(transitionDef('dissolve')?.label).toBe('Cross dissolve');
  });
});

describe('caption styles', () => {
  it('falls back to the default style for unknown ids', () => {
    expect(captionStyle('bold-pop').karaoke).toBe(true);
    expect(captionStyle('nope').id).toBe('default');
    expect(new Set(CAPTION_STYLES.map((s) => s.id)).size).toBe(CAPTION_STYLES.length);
  });
});

describe('captionsForClip — timing', () => {
  it('breaks on sentences and pauses; every word lands within a frame of the transcript; no overlaps', () => {
    const caps = captionsForClip(SPEECH, clip(), tb);
    expect(caps.map((c) => c.words.map((x) => x.text).join(' '))).toEqual(['Hello there, this is a test.', 'Second sentence here.']);
    const flat = caps.flatMap((c) => c.words);
    SPEECH.forEach((src, i) => {
      expect(Math.abs(flat[i]!.start - (src.startMs / 1000) * tb.rate)).toBeLessThanOrEqual(1); // sub-tick rounding only
      expect(Math.abs(flat[i]!.end - (src.endMs / 1000) * tb.rate)).toBeLessThanOrEqual(1);
    });
    for (const c of caps) {
      expect(c.start % F).toBe(0);
      expect(c.duration % F).toBe(0);
      for (const x of c.words) {
        expect(x.start).toBeGreaterThanOrEqual(c.start);
        expect(x.end).toBeLessThanOrEqual(c.start + c.duration);
      }
    }
    for (let i = 1; i < caps.length; i++) expect(caps[i]!.start).toBeGreaterThanOrEqual(caps[i - 1]!.start + caps[i - 1]!.duration);
    // appears no later than its first word (frame floor) and holds past its last word (frame ceil)
    expect(caps[0]!.start).toBeLessThanOrEqual(1.0 * tb.rate);
    expect(caps[0]!.start + caps[0]!.duration).toBeGreaterThanOrEqual(3.0 * tb.rate);
  });

  it('follows the clip: trim, position and speed move the captions with the picture', () => {
    // clip plays media 2.0 s … 8.0 s, placed at timeline 10 s
    const c = clip({ start: 10 * tb.rate, duration: 6 * tb.rate, sourceIn: 2 * tb.rate });
    const caps = captionsForClip(SPEECH, c, tb);
    const first = caps[0]!.words[0]!;
    expect(first.text).toBe('this');
    expect(first.start).toBe(10 * tb.rate); // media 2.0 s ↔ timeline 10.0 s
    expect(caps.at(-1)!.words.at(-1)!.text).toBe('here.');
    // double speed halves every distance from the clip start
    const fast = clip({ start: 0, duration: 3 * tb.rate, sourceIn: 2 * tb.rate, speed: { num: 2, den: 1 } });
    const fcaps = captionsForClip(SPEECH, fast, tb);
    const sec = fcaps.at(-1)!.words.find((x) => x.text === 'Second')!;
    expect(sec.start).toBe(Math.round(((6 - 2) / 2) * tb.rate)); // 2.0 s
    // words wholly outside the clip are dropped, words straddling its edge are clamped to it
    const cut = clip({ start: 0, duration: 2 * tb.rate, sourceIn: 1.2 * tb.rate });
    const cc = captionsForClip(SPEECH, cut, tb);
    expect(cc.flatMap((x) => x.words).every((x) => x.start >= 0 && x.end <= 2 * tb.rate)).toBe(true);
    expect(cc[0]!.words[0]!.text).toBe('Hello'); // "Hello" 1.0–1.4 straddles the new in-point
    expect(cc[0]!.words[0]!.start).toBe(0);
  });

  it('respects line capacity, maximum length and minimum length', () => {
    const long = Array.from({ length: 30 }, (_, i) => w(`word${i}`, i * 0.3, i * 0.3 + 0.25));
    const caps = captionsForClip(long, clip(), tb, { maxCharsPerLine: 20, maxLines: 1 });
    expect(caps.length).toBeGreaterThan(3);
    for (const c of caps) expect(c.words.map((x) => x.text).join(' ').length).toBeLessThanOrEqual(21);
    const slow = captionsForClip([w('a', 0, 0.2), w('b', 20, 20.2)], clip(), tb); // 20 s of silence between → two captions
    expect(slow).toHaveLength(2);
    expect(slow[0]!.duration).toBeGreaterThanOrEqual(0.7 * tb.rate - F); // padded up to the minimum
    const capped = captionsForClip(Array.from({ length: 40 }, (_, i) => w(`x${i}`, i * 0.5, i * 0.5 + 0.4)), clip(), tb, { maxCharsPerLine: 200, maxSeconds: 4 });
    expect(Math.max(...capped.map((c) => c.duration)) / tb.rate).toBeLessThanOrEqual(4.1);
  });

  it('finds the spoken word for karaoke styles', () => {
    const c = captionsForClip(SPEECH, clip(), tb)[0]!;
    expect(activeWordIndex(c, 0)).toBe(-1);
    expect(activeWordIndex(c, 1.5 * tb.rate)).toBe(1);
    expect(activeWordIndex(c, 2.9 * tb.rate)).toBe(5);
  });

  it('writes SRT and WebVTT', () => {
    const caps = captionsForClip(SPEECH, clip(), tb).map((c) => ({ ...c }));
    const srt = captionsToSubtitles(caps, tb);
    expect(srt.startsWith('1\n00:00:01,000 --> 00:00:03,000\nHello there, this is a test.\n\n2\n')).toBe(true);
    const vtt = captionsToSubtitles(caps, tb, 'vtt');
    expect(vtt.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there, this is a test.')).toBe(true);
  });
});
