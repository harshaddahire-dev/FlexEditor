import { useEffect } from 'react';
import { AlertTriangle, Check, Download, Loader2 } from 'lucide-react';
import { useWhisper } from '../store/whisper';
import { ICON } from './ui';

/** Detects whether transcription (whisper.cpp + a model) is set up and, if not, installs it with one click. */
export function WhisperCard({ compact = false }: { compact?: boolean }) {
  const { setup, model, setModel, load, install, cancel } = useWhisper();
  useEffect(() => void load(), [load]);
  if (!setup) return null;
  const { install: st, plan } = setup;
  const running = st.status === 'running';

  if (setup.available && !running && st.status !== 'error') {
    return compact ? null : (
      <p className="row whisper__ok" role="status"><Check {...ICON} size={14} />Transcription is ready{setup.model ? ` (${setup.model})` : ''}.</p>
    );
  }
  const size = (id: string) => setup.models.find((m) => m.id === id)?.sizeMb ?? 0;
  const parts = [plan.binary === 'download' ? 'whisper.cpp (about 5 MB)' : plan.binary === 'brew' ? 'whisper.cpp (with Homebrew)' : plan.binary === 'build' ? 'whisper.cpp (built here, a few minutes)' : null, plan.model ? `the ${model} model (about ${size(model)} MB)` : null].filter(Boolean);

  return (
    <div className="whisper" data-testid="whisper-card">
      {running ? (
        <>
          <p className="row" role="status"><Loader2 {...ICON} size={14} className="spin" />{st.message}{st.step ? ` · ${st.percent}%` : ''}</p>
          <span className="whisper__bar"><i style={{ width: `${st.percent}%` }} /></span>
          <div><button className="btn btn--sm" onClick={() => void cancel()}>Cancel</button></div>
        </>
      ) : plan.binary === 'unsupported' ? (
        <p className="faint">{plan.note ?? 'whisper.cpp has to be installed by hand on this machine.'}</p>
      ) : (
        <>
          <p className="faint">Downloads {parts.join(' and ')} once, then transcribes offline on this computer.</p>
          {plan.model ? (
            <label className="row whisper__pick">
              <span className="label">Model</span>
              <select className="input" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Transcription model">
                {setup.models.map((m) => <option key={m.id} value={m.id}>{m.label} · {m.sizeMb} MB</option>)}
              </select>
            </label>
          ) : null}
          <div><button className="btn btn--primary btn--sm" onClick={() => void install()}><Download {...ICON} size={13} />Install transcription</button></div>
        </>
      )}
      {st.status === 'error' ? <p className="msg__error" role="alert"><AlertTriangle size={13} />{st.error}</p> : null}
    </div>
  );
}
