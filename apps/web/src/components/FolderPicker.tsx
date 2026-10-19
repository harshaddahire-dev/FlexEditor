import { useCallback, useEffect, useState } from 'react';
import { ArrowUp, Folder } from 'lucide-react';
import type { FsListing } from '@cutroom/core';
import { api } from '../lib/api';
import { ICON, Modal } from './ui';

/** Server-side folder browser — browsers cannot hand a web page absolute paths, but the local server can list them. */
export function FolderPicker({
  open,
  onOpenChange,
  onChoose,
  startAt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (path: string) => void;
  startAt?: string;
}) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const go = useCallback(async (path?: string) => {
    try {
      const l = await api.listDir(path);
      setListing(l);
      setInput(l.path);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void go(startAt);
  }, [open, go, startAt]);

  const here = listing?.path ?? '';
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Open project folder"
      width={560}
      footer={
        <>
          <span className="muted">
            {listing && here ? `${listing.mediaFiles} media file${listing.mediaFiles === 1 ? '' : 's'} in this folder` : ''}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!here}
            onClick={() => {
              onChoose(here);
              onOpenChange(false);
            }}
          >
            Open this folder
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void go(input);
          }}
        >
          <button type="button" className="btn btn--icon" aria-label="Parent folder" disabled={listing?.parent == null} onClick={() => void go(listing?.parent ?? undefined)}>
            <ArrowUp {...ICON} />
          </button>
          <input className="input input--mono" style={{ flex: 1 }} value={input} onChange={(e) => setInput(e.target.value)} aria-label="Folder path" spellCheck={false} />
          <button className="btn" type="submit">
            Go
          </button>
        </form>
        {listing?.quickLinks.length ? (
          <div className="chips">
            {listing.quickLinks.map((q) => (
              <button key={q.path} className="chip" onClick={() => void go(q.path)}>
                {q.label}
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <div className="callout" role="alert">
            {error}
          </div>
        ) : null}
        <div className="picker__list" role="list" aria-label="Folders">
          {listing?.entries.map((e) => (
            <button key={e.path} className="picker__item" role="listitem" onClick={() => void go(e.path)} onDoubleClick={() => { onChoose(e.path); onOpenChange(false); }}>
              <Folder {...ICON} />
              <span>{e.name}</span>
            </button>
          ))}
          {listing && !listing.entries.length ? <div className="empty">No sub-folders.</div> : null}
          {!listing && !error ? (
            <div className="empty">
              <div className="skeleton" style={{ width: 160, height: 12, borderRadius: 3 }} />
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
