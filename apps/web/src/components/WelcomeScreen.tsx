import { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { useApp } from '../store/app';
import { FolderPicker } from './FolderPicker';
import { ICON, Tip } from './ui';

export function WelcomeScreen() {
  const { recent, opening, openError, openProject, forgetRecent } = useApp();
  const ffmpegWarnings = useApp((s) => s.health?.ffmpeg.warnings ?? []);
  const [picker, setPicker] = useState(false);
  const [path, setPath] = useState('');

  return (
    <main className="screen">
      <div className="screen__col">
        <h1>Cutroom</h1>
        <p className="muted">
          Open a folder of footage to start. Cutroom keeps the project, proxies and analysis in a <code>.cutroom</code> folder inside it — your
          original files are never modified.
        </p>

        <div className="row">
          <button className="btn btn--primary" onClick={() => setPicker(true)} disabled={opening}>
            <FolderOpen {...ICON} />
            Open folder…
          </button>
          <span className="faint">or paste a path</span>
          <form
            className="row"
            style={{ flex: 1 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (path.trim()) void openProject(path.trim());
            }}
          >
            <input className="input input--mono" style={{ flex: 1 }} placeholder="/path/to/footage" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Project folder path" spellCheck={false} />
            <button className="btn" type="submit" disabled={opening || !path.trim()}>
              Open
            </button>
          </form>
        </div>

        {opening ? <p className="muted" role="status">Scanning folder and reading media…</p> : null}
        {openError ? (
          <div className="callout" role="alert">
            {openError}
          </div>
        ) : null}
        {ffmpegWarnings.length ? (
          <div className="callout callout--warn">
            <span className="section-title">FFmpeg notes</span>
            <ul>
              {ffmpegWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {recent.length ? (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
            <span className="section-title">Recent</span>
            <div className="recent">
              {recent.map((r) => (
                <div key={r.path} className="row" style={{ borderBottom: '1px solid var(--line)' }}>
                  <button className="recent__item" style={{ flex: 1, borderBottom: 0 }} onClick={() => void openProject(r.path)} disabled={opening}>
                    <span>{r.name}</span>
                    <span className="faint mono">{r.path}</span>
                  </button>
                  <Tip label="Remove from recent">
                    <button className="btn btn--ghost btn--icon" aria-label={`Remove ${r.name} from recent`} onClick={() => void forgetRecent(r.path)}>
                      <X {...ICON} />
                    </button>
                  </Tip>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
      <FolderPicker open={picker} onOpenChange={setPicker} onChoose={(p) => void openProject(p)} />
    </main>
  );
}
