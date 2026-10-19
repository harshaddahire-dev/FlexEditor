import { useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Plug, Plus, Trash2, XCircle } from 'lucide-react';
import { PROVIDER_PRESETS, type ProviderInfo, type ProviderKind } from '@cutroom/core';
import { useAgent } from '../store/agent';
import { ICON } from './ui';

const KINDS = Object.keys(PROVIDER_PRESETS) as ProviderKind[];

/** Add or edit one provider. The key is write-only: it is sent to the server once and never shown again. */
function ProviderForm({ initial, onDone }: { initial?: ProviderInfo; onDone(): void }) {
  const { addProvider, updateProvider } = useAgent();
  const [kind, setKind] = useState<ProviderKind>(initial?.kind ?? 'openrouter');
  const preset = PROVIDER_PRESETS[kind];
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? preset.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (k: ProviderKind) => {
    setKind(k);
    setBaseUrl(PROVIDER_PRESETS[k].baseUrl);
  };

  return (
    <form
      className="pform"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const keyField = removeKey ? { apiKey: '' } : apiKey.trim() ? { apiKey: apiKey.trim() } : {};
          if (initial) await updateProvider(initial.id, { name, ...(preset.editableUrl ? { baseUrl } : {}), ...keyField });
          else await addProvider({ kind, name: name || undefined, ...(preset.editableUrl ? { baseUrl } : {}), ...keyField });
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {!initial ? (
        <div className="pform__kinds" role="radiogroup" aria-label="Provider">
          {KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className="pform__kind" data-on={kind === k} onClick={() => pick(k)}>
              {PROVIDER_PRESETS[k].label}
            </button>
          ))}
        </div>
      ) : null}
      <label className="label" htmlFor="prov-name">Name</label>
      <input id="prov-name" className="input" placeholder={preset.label} value={name} onChange={(e) => setName(e.target.value)} />
      {preset.editableUrl ? (
        <>
          <label className="label" htmlFor="prov-url">Base URL</label>
          <input id="prov-url" className="input input--mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
        </>
      ) : null}
      <label className="label" htmlFor="prov-key">API key</label>
      <div className="pform__key">
        <KeyRound {...ICON} />
        <input
          id="prov-key"
          className="input input--mono"
          type="password"
          autoComplete="off"
          placeholder={initial?.hasKey ? `•••• ${initial.keyHint ?? ''} — leave blank to keep` : preset.keyPlaceholder}
          value={apiKey}
          disabled={removeKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        {preset.keyUrl ? (
          <a className="pform__link" href={preset.keyUrl} target="_blank" rel="noreferrer noopener">
            Get a key <ExternalLink size={11} />
          </a>
        ) : null}
      </div>
      {initial?.hasKey ? (
        <label className="pform__check">
          <input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} /> Remove the stored key
        </label>
      ) : null}
      <p className="faint pform__note">Keys are encrypted on this machine and only used by the local server. They are never sent to the browser or into projects.</p>
      {error ? <div className="callout" role="alert">{error}</div> : null}
      <div className="row">
        <button className="btn btn--primary" type="submit" disabled={busy}>{initial ? 'Save' : 'Add provider'}</button>
        <button className="btn btn--ghost" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function ProviderCard({ p, onEdit }: { p: ProviderInfo; onEdit(): void }) {
  const { testProvider, removeProvider, tests } = useAgent();
  const t = tests[p.id];
  return (
    <li className="pcard">
      <div className="pcard__main">
        <strong>{p.name}</strong>
        <span className="faint">{PROVIDER_PRESETS[p.kind].label}</span>
        <span className="faint mono pcard__url">{p.baseUrl}</span>
        <span className="pcard__key" data-on={p.hasKey}>{p.hasKey ? `Key •••• ${p.keyHint ?? ''}` : 'No key'}</span>
      </div>
      <div className="pcard__actions">
        {t === 'testing' ? <span className="faint row"><Loader2 size={13} className="spin" /> Testing…</span> : null}
        {t && t !== 'testing' ? (
          t.ok ? (
            <span className="pcard__ok row" role="status"><CheckCircle2 size={14} /> {t.models} models</span>
          ) : (
            <span className="pcard__bad row" role="alert" title={t.error}><XCircle size={14} /> {t.error}</span>
          )
        ) : null}
        <button className="btn btn--sm" onClick={() => void testProvider(p.id)} disabled={t === 'testing'}><Plug size={13} />Test</button>
        <button className="btn btn--sm" onClick={onEdit}>Edit</button>
        <button className="btn btn--ghost btn--icon btn--sm" aria-label={`Remove ${p.name}`} onClick={() => void removeProvider(p.id)}><Trash2 size={13} /></button>
      </div>
    </li>
  );
}

export function ProvidersTab() {
  const providers = useAgent((s) => s.providers);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  return (
    <div className="providers">
      <p className="muted">Connect the model provider the editing agents will use. Any OpenAI-compatible endpoint works too, including local servers like Ollama or LM Studio.</p>
      {providers.length ? (
        <ul className="plist">
          {providers.map((p) =>
            editing === p.id ? (
              <li key={p.id} className="pcard pcard--form"><ProviderForm initial={p} onDone={() => setEditing(null)} /></li>
            ) : (
              <ProviderCard key={p.id} p={p} onEdit={() => setEditing(p.id)} />
            ),
          )}
        </ul>
      ) : null}
      {editing === 'new' ? (
        <div className="pcard pcard--form"><ProviderForm onDone={() => setEditing(null)} /></div>
      ) : (
        <div><button className="btn btn--primary" onClick={() => setEditing('new')}><Plus {...ICON} />Add provider</button></div>
      )}
    </div>
  );
}
