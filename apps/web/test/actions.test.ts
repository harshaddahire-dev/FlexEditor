import { afterEach, describe, expect, it } from 'vitest';
import { ACTIONS, actionFor, keyOf, setMac } from '../src/lib/actions';

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
afterEach(() => setMac(false));

describe('keyboard map', () => {
  it('normalises events', () => {
    expect(keyOf(ev(' '))).toBe('Space');
    expect(keyOf(ev('Z', { shiftKey: true }))).toBe('Shift+z');
    expect(keyOf(ev('+', { shiftKey: true }))).toBe('+'); // the character already says "shift"
    expect(keyOf(ev('ArrowLeft', { shiftKey: true }))).toBe('Shift+ArrowLeft');
    expect(keyOf(ev('x', { altKey: true }))).toBe('Alt+x');
  });
  it('Mod is Ctrl on Windows/Linux and Cmd on macOS', () => {
    expect(keyOf(ev('z', { ctrlKey: true }))).toBe('Mod+z');
    expect(keyOf(ev('z', { metaKey: true }))).toBe('z');
    setMac(true);
    expect(keyOf(ev('z', { metaKey: true }))).toBe('Mod+z');
    expect(keyOf(ev('z', { ctrlKey: true }))).toBe('z');
  });
  it('maps the spec shortcuts', () => {
    const id = (e: ReturnType<typeof ev>) => actionFor(e)?.id;
    expect(id(ev(' '))).toBe('play');
    expect(id(ev('j'))).toBe('shuttle.back');
    expect(id(ev('k'))).toBe('shuttle.stop');
    expect(id(ev('l'))).toBe('shuttle.fwd');
    expect(id(ev('i'))).toBe('mark.in');
    expect(id(ev('o'))).toBe('mark.out');
    expect(id(ev('c'))).toBe('tool.blade');
    expect(id(ev('v'))).toBe('tool.select');
    expect(id(ev('a'))).toBe('tool.forward');
    expect(id(ev('q'))).toBe('edit.trimStart');
    expect(id(ev('w'))).toBe('edit.trimEnd');
    expect(id(ev('z', { ctrlKey: true }))).toBe('edit.undo');
    expect(id(ev('Z', { ctrlKey: true, shiftKey: true }))).toBe('edit.redo');
    expect(id(ev('+', { shiftKey: true }))).toBe('view.zoomIn');
    expect(id(ev('-'))).toBe('view.zoomOut');
    expect(id(ev('Z', { shiftKey: true }))).toBe('view.fit');
    expect(id(ev('m'))).toBe('edit.marker');
    expect(id(ev('l', { ctrlKey: true }))).toBe('app.agent');
  });
  it('has no shortcut bound to two actions, and every action has a label and a group', () => {
    const seen = new Map<string, string>();
    for (const a of ACTIONS) {
      expect(a.label.length).toBeGreaterThan(2);
      for (const k of a.keys) {
        expect(seen.has(k), `${k} is bound to both ${seen.get(k)} and ${a.id}`).toBe(false);
        seen.set(k, a.id);
      }
    }
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
  });
  it('user overrides replace the default keys', () => {
    expect(actionFor(ev('x'), { play: ['x'] })?.id).toBe('play');
    expect(actionFor(ev(' '), { play: ['x'] })).toBeUndefined();
  });
});
