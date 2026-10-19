import { useEffect, useState } from 'react';
import type { Media } from '@cutroom/core';
import { api, ApiError } from '../lib/api';
import { useApp } from '../store/app';
import { Modal } from './ui';

export function RelinkDialog({ media, onClose }: { media: Media | null; onClose: () => void }) {
  const relink = useApp((s) => s.relink);
  const [path, setPath] = useState('');
  const [candidates, setCandidates] = useState<string[]>([]);
  const [error, setError] = useState<{ message: string; mismatch: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState('');

  useEffect(() => {
    setPath('');
    setError(null);
    setCandidates([]);
    if (media) api.relinkCandidates(media.id).then(setCandidates, () => setCandidates([]));
  }, [media]);

  const attempt = async (p: string, force: boolean) => {
    if (!media) return;
    setBusy(true);
    setTried(p);
    try {
      await relink(media.id, p, force);
      onClose();
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e), mismatch: e instanceof ApiError && e.code === 'relink_mismatch' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!media} onOpenChange={(o) => !o && onClose()} title="Relink missing media" width={560}>
      {media ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          <p className="muted">
            <strong>{media.name}</strong> was last seen at <code>{media.path}</code>. Point it at the file's new location; edits that use it are kept.
          </p>
          {candidates.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
              <span className="section-title">Same name found in the project</span>
              {candidates.map((c) => (
                <button key={c} className="btn" style={{ justifyContent: 'flex-start' }} disabled={busy} onClick={() => void attempt(c, false)}>
                  {c}
                </button>
              ))}
            </div>
          ) : null}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (path.trim()) void attempt(path.trim(), false);
            }}
          >
            <input className="input input--mono" style={{ flex: 1 }} placeholder="/new/location/of/file.mp4" value={path} onChange={(e) => setPath(e.target.value)} aria-label="New file path" spellCheck={false} />
            <button className="btn btn--primary" type="submit" disabled={busy || !path.trim()}>Relink</button>
          </form>
          {error ? (
            <div className="callout callout--warn" role="alert">
              <span>{error.message}</span>
              {error.mismatch ? (
                <div>
                  <button className="btn" disabled={busy} onClick={() => void attempt(tried, true)}>
                    Relink anyway
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
