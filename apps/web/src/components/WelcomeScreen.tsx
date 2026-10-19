import { useState } from 'react';
import { Bot, Clapperboard, Folder, FolderOpen, Waves, X } from 'lucide-react';
import { useApp } from '../store/app';
import { FolderPicker } from './FolderPicker';
import { Logo } from './Logo';
import { ICON, Tip } from './ui';

const HIGHLIGHTS = [
  { icon: Clapperboard, title: 'Frame-accurate', text: 'Integer time. A cut lands on its frame and its sample, every time.' },
  { icon: Waves, title: 'Knows your footage', text: 'Waveforms, loudness, silences, scenes, beats and a transcript, built in the background.' },
  { icon: Bot, title: 'Agents edit for you', text: 'Describe the cut; review it as a diff you can accept, tweak or undo.' },
];

export function WelcomeScreen() {
  const { recent, opening, openError, openProject, forgetRecent } = useApp();
  const ffmpegWarnings = useApp((s) => s.health?.ffmpeg.warnings ?? []);
  const [picker, setPicker] = useState(false);
  const [path, setPath] = useState('');

  return (
    <main className="screen screen--welcome">
      <div className="welcome">
        <header className="welcome__brand">
          <Logo size={40} />
          <div>
            <h1>Cutroom</h1>
            <p className="muted">Local-first video editing where agents do the cutting.</p>
          </div>
        </header>

        <section className="welcome__card" aria-label="Open footage">
          <div className="welcome__lead">
            <span className="section-title">Start</span>
            <p className="muted">
              Pick a folder of footage. Cutroom keeps the project, proxies and analysis in a <code>.cutroom</code> folder inside it — your
              originals are never modified.
            </p>
          </div>
          <div className="welcome__actions">
            <button className="btn btn--primary btn--lg" onClick={() => setPicker(true)} disabled={opening}>
              <FolderOpen {...ICON} />
              Open folder…
            </button>
            <span className="faint">or paste a path</span>
            <form
              className="welcome__path"
              onSubmit={(e) => {
                e.preventDefault();
                if (path.trim()) void openProject(path.trim());
              }}
            >
              <input className="input input--mono" placeholder="/path/to/footage" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Project folder path" spellCheck={false} />
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
        </section>

        {recent.length ? (
          <section className="welcome__recent" aria-label="Recent projects">
            <span className="section-title">Recent</span>
            <ul className="recent">
              {recent.map((r) => (
                <li key={r.path} className="recent__row">
                  <button className="recent__item" onClick={() => void openProject(r.path)} disabled={opening}>
                    <Folder {...ICON} />
                    <span className="recent__text">
                      <span className="recent__name">{r.name}</span>
                      <span className="faint mono recent__path">{r.path}</span>
                    </span>
                  </button>
                  <Tip label="Remove from recent">
                    <button className="btn btn--ghost btn--icon" aria-label={`Remove ${r.name} from recent`} onClick={() => void forgetRecent(r.path)}>
                      <X {...ICON} />
                    </button>
                  </Tip>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <ul className="welcome__facts">
          {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
            <li key={title}>
              <Icon {...ICON} />
              <strong>{title}</strong>
              <span className="muted">{text}</span>
            </li>
          ))}
        </ul>
      </div>
      <FolderPicker open={picker} onOpenChange={setPicker} onChoose={(p) => void openProject(p)} />
    </main>
  );
}
