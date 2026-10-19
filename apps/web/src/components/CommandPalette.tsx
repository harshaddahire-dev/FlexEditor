import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import * as Dialog from '@radix-ui/react-dialog';
import { ACTIONS, actionFor } from '../lib/actions';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function formatKeys(keys: string[]): string {
  const k = keys[0];
  if (!k) return '';
  return k
    .split('+')
    .map((p) => (p === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : p === 'Shift' ? (isMac ? '⇧' : 'Shift') : p === 'Alt' ? (isMac ? '⌥' : 'Alt') : p === 'Space' ? 'Space' : p.length === 1 ? p.toUpperCase() : p.replace('Arrow', '')))
    .join(isMac ? '' : '+');
}

/** Global keyboard shortcuts + the ⌘K command palette. */
export function KeyboardLayer() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = (isMac ? e.metaKey : e.ctrlKey) && !e.altKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const action = actionFor(e);
      if (!action) return;
      e.preventDefault();
      void action.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-scrim" />
        <Dialog.Content className="palette" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command label="Command palette" loop>
            <Command.Input className="palette__input" placeholder="Type a command…" autoFocus />
            <Command.List className="palette__list">
              <Command.Empty className="empty">No matching command.</Command.Empty>
              {(['Playback', 'Edit', 'Timeline', 'Tools', 'View', 'App'] as const).map((g) => {
                const items = ACTIONS.filter((a) => a.group === g);
                return items.length ? (
                  <Command.Group key={g} heading={g}>
                    {items.map((a) => (
                      <Command.Item
                        key={a.id}
                        value={`${a.label} ${a.id}`}
                        onSelect={() => {
                          setOpen(false);
                          requestAnimationFrame(() => void a.run());
                        }}
                      >
                        <span>{a.label}</span>
                        <span className="kbd">{formatKeys(a.keys)}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ) : null;
              })}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
