import { useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { useApp } from '../store/app';
import { ICON } from './ui';

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const isCommand = !/^(or:|Then )/.test(text);
  return (
    <div className="codeblock">
      <span>{text}</span>
      {isCommand ? (
        <button
          className="btn btn--ghost btn--icon btn--sm"
          aria-label={`Copy ${text}`}
          onClick={() => {
            void navigator.clipboard?.writeText(text.replace(/\s{2,}\(.*\)$/, '').replace(/^or: /, ''));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check {...ICON} /> : <Copy {...ICON} />}
        </button>
      ) : null}
    </div>
  );
}

/** Shown instead of the app when FFmpeg is missing or unusable. */
export function SetupScreen() {
  const ffmpeg = useApp((s) => s.health?.ffmpeg);
  const recheck = useApp((s) => s.recheckFfmpeg);
  const [busy, setBusy] = useState(false);
  if (!ffmpeg) return null;

  return (
    <main className="screen">
      <div className="screen__col">
        <h1>FFmpeg is required</h1>
        <p className="muted">
          Cutroom uses FFmpeg and ffprobe on this machine to read media, build edit proxies and export. Install it once, then check again.
        </p>
        <div className="callout" role="alert">
          <span className="section-title">Problems</span>
          <ul>
            {ffmpeg.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
        <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
          <span className="section-title">Install</span>
          {ffmpeg.installHints.map((h) => (
            <CopyLine key={h} text={h} />
          ))}
        </section>
        <div className="row">
          <button
            className="btn btn--primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await recheck();
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw {...ICON} />
            {busy ? 'Checking…' : 'Check again'}
          </button>
          <span className="faint">Detected on {ffmpeg.platform}</span>
        </div>
      </div>
    </main>
  );
}
