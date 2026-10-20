import { useEffect } from 'react';
import { ArrowDownToLine, Loader2, RefreshCw } from 'lucide-react';
import { desktop } from '../lib/native';
import { useUpdates } from '../store/updates';
import { ICON, Modal, Tip } from './ui';

/** Top-bar notice for desktop updates: appears only when there is something to do. */
export function UpdatePill() {
  const { state, init, download, install, confirmBusy, dismissBusy } = useUpdates();
  useEffect(() => init(), [init]);
  if (!desktop() || !state) return null;

  const { status, latest, percent } = state;
  let pill = null;
  if (status === 'downloading') {
    pill = (
      <Tip label={`Downloading Cutroom ${latest} in the background — you can keep working`}>
        <span className="update-pill" role="status" data-testid="update-pill" data-status={status}>
          <Loader2 {...ICON} size={13} className="spin" />Updating {percent}%
        </span>
      </Tip>
    );
  } else if (status === 'ready') {
    pill = (
      <Tip label="Restart Cutroom to finish updating. Your project is saved automatically.">
        <button className="btn btn--sm update-pill update-pill--ready" data-testid="update-pill" data-status={status} onClick={() => void install(false)}>
          <RefreshCw {...ICON} size={13} />Restart to update to {latest}
        </button>
      </Tip>
    );
  } else if (status === 'available') {
    pill = (
      <Tip label={state.canInstall ? `Cutroom ${latest} is available` : 'This build cannot update itself — opens the download page'}>
        <button className="btn btn--sm update-pill" data-testid="update-pill" data-status={status} onClick={() => void download()}>
          <ArrowDownToLine {...ICON} size={13} />{state.canInstall ? `Download ${latest}` : `Get ${latest}`}
        </button>
      </Tip>
    );
  }

  return (
    <>
      {pill}
      <Modal
        open={confirmBusy}
        onOpenChange={(o) => !o && dismissBusy()}
        title="Restart while work is running?"
        footer={
          <>
            <button className="btn" onClick={dismissBusy}>Keep working</button>
            <button className="btn btn--primary" onClick={() => void install(true)}>Restart anyway</button>
          </>
        }
      >
        <p>A render, analysis or agent run is still in progress. Restarting now stops it. Your project and timeline are saved.</p>
      </Modal>
    </>
  );
}
