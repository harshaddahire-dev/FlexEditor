import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useApp } from '../store/app';
import { ICON } from './ui';

const SHOW_FAILED_MS = 8000;

/** Background work only: uploads and running/failed jobs. Finished jobs show in the bin instead. */
export function Toasts() {
  const uploads = useApp((s) => s.uploads);
  const jobs = useApp((s) => s.jobs);
  const { dismissUpload, cancelJob } = useApp();
  const [now, setNow] = useState(() => Date.now());

  const anyFailed = Object.values(jobs).some((j) => j.state === 'failed');
  useEffect(() => {
    if (!anyFailed) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyFailed]);

  const live = Object.values(jobs).filter(
    (j) => j.state === 'queued' || j.state === 'running' || (j.state === 'failed' && now - (j.finishedAt ?? 0) < SHOW_FAILED_MS),
  );
  const rows = [
    ...uploads.map((u) => ({
      key: u.id,
      label: `Uploading ${u.name}`,
      progress: u.total ? u.loaded / u.total : 0,
      state: u.state === 'failed' ? 'failed' : u.state === 'done' ? 'done' : 'running',
      detail: u.error,
      onClose: () => dismissUpload(u.id),
    })),
    ...live.map((j) => ({
      key: j.id,
      label: j.label,
      progress: j.progress,
      state: j.state,
      detail: j.error,
      onClose: j.state === 'failed' ? undefined : () => void cancelJob(j.id),
    })),
  ];
  if (!rows.length) return null;
  const shown = rows.slice(0, 4);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {shown.map((r) => (
        <div key={r.key} className="toast" data-state={r.state}>
          <span className="toast__label" title={r.detail ?? r.label}>{r.state === 'failed' ? `Failed — ${r.label}` : r.label}</span>
          {r.onClose ? (
            <button className="btn btn--ghost btn--icon btn--sm" aria-label={r.state === 'failed' ? 'Dismiss' : 'Cancel'} onClick={r.onClose}><X {...ICON} /></button>
          ) : <span />}
          <span className="toast__bar"><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></span>
          {r.state === 'failed' && r.detail ? <span className="faint" style={{ gridColumn: '1 / -1' }}>{r.detail}</span> : null}
        </div>
      ))}
      {rows.length > shown.length ? <div className="faint" style={{ padding: '0 var(--s-2)' }}>+{rows.length - shown.length} more</div> : null}
    </div>
  );
}
