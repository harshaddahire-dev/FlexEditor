import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Plug, Plus, RefreshCw, Trash2, TriangleAlert, XCircle } from 'lucide-react';
import type { ExtStatus, McpServerInfo, McpServerInput, McpTransport } from '@cutroom/core';
import { useExtensions } from '../store/extensions';
import { ICON } from './ui';

/** `--flag "a b" c` → ['--flag', 'a b', 'c'] */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** `KEY=value` or `Name: value` lines → record. */
export function parsePairs(text: string, sep: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function StatusDot({ status, error }: { status: ExtStatus; error?: string }) {
  if (status === 'connecting') return <span className="faint row"><Loader2 size={12} className="spin" /> Connecting…</span>;
  if (status === 'ready') return <span className="pcard__ok row" role="status"><CheckCircle2 size={13} /> Ready</span>;
  if (status === 'error') return <span className="pcard__bad row" role="alert" title={error}><XCircle size={13} /> {error ?? 'Failed'}</span>;
  return <span className="faint">Off</span>;
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" />
    </label>
  );
}

function McpForm({ initial, onDone }: { initial?: McpServerInfo; onDone(): void }) {
  const { saveMcp } = useExtensions();
  const [name, setName] = useState(initial?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? 'stdio');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [args, setArgs] = useState((initial?.args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
  const [url, setUrl] = useState(initial?.url ?? '');
  const [env, setEnv] = useState('');
  const [headers, setHeaders] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = transport === 'stdio' ? initial?.envKeys : initial?.headerKeys;
  return (
    <form
      className="pform"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const input: McpServerInput = { name, transport, ...(transport === 'stdio' ? { command, args: splitArgs(args), env: parsePairs(env, '=') } : { url, headers: parsePairs(headers, ':') }) };
        try {
          await saveMcp(input, initial?.id);
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="label" htmlFor="mcp-name">Name</label>
      <input id="mcp-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Stock footage" />
      <div className="pform__kinds" role="radiogroup" aria-label="Transport">
        <button type="button" role="radio" aria-checked={transport === 'stdio'} className="pform__kind" data-on={transport === 'stdio'} onClick={() => setTransport('stdio')}>Command (stdio)</button>
        <button type="button" role="radio" aria-checked={transport === 'http'} className="pform__kind" data-on={transport === 'http'} onClick={() => setTransport('http')}>HTTP URL</button>
      </div>
      {transport === 'stdio' ? (
        <>
          <label className="label" htmlFor="mcp-cmd">Command</label>
          <input id="mcp-cmd" className="input input--mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} />
          <label className="label" htmlFor="mcp-args">Arguments</label>
          <input id="mcp-args" className="input input--mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @acme/mcp-server" spellCheck={false} />
          <label className="label" htmlFor="mcp-env">Environment (one KEY=value per line)</label>
          <textarea id="mcp-env" className="input input--mono" rows={2} value={env} onChange={(e) => setEnv(e.target.value)} placeholder={keys?.length ? keys.map((k) => `${k}=•••• (kept)`).join('\n') : 'API_KEY=…'} spellCheck={false} />
        </>
      ) : (
        <>
          <label className="label" htmlFor="mcp-url">URL</label>
          <input id="mcp-url" className="input input--mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" spellCheck={false} />
          <label className="label" htmlFor="mcp-headers">Headers (one Name: value per line)</label>
          <textarea id="mcp-headers" className="input input--mono" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder={keys?.length ? keys.map((k) => `${k}: •••• (kept)`).join('\n') : 'Authorization: Bearer …'} spellCheck={false} />
        </>
      )}
      <p className="faint pform__note">Values are encrypted on this machine and never sent back to the browser. {initial ? 'Leave blank to keep stored values; “KEY=” alone removes one.' : ''}</p>
      {error ? <div className="callout" role="alert">{error}</div> : null}
      <div className="row">
        <button className="btn btn--primary" type="submit" disabled={busy}>{initial ? 'Save' : 'Add server'}</button>
        <button className="btn btn--ghost" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

export function ExtensionsTab() {
  const { info, error, loading, load, reload, setPlugin, setMcp, testMcp, removeMcp } = useExtensions();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  useEffect(() => void load(), [load]);
  return (
    <div className="providers">
      <div className="callout callout--warn ext__warn">
        <TriangleAlert {...ICON} size={14} />
        <span>Plugins and MCP servers run code outside Cutroom with your permissions. Agents can use their tools only in <strong>Full access</strong> mode.</span>
      </div>
      {error ? <div className="callout" role="alert">{error}</div> : null}

      <h3 className="ext__h">Plugins</h3>
      <ul className="plist" aria-label="Plugins">
        {info?.plugins.map((p) => (
          <li key={p.id} className="pcard" data-testid={`plugin-${p.id}`}>
            <div className="pcard__main">
              <strong>{p.name}</strong>
              <span className="faint mono">v{p.version}</span>
              {p.description ? <span className="faint">{p.description}</span> : null}
              {p.tools.length ? <span className="ext__tools">{p.tools.map((t) => <span key={t.name} className="chip mono" title={t.description}>{t.name}</span>)}</span> : null}
            </div>
            <div className="pcard__actions">
              <StatusDot status={p.status} error={p.error} />
              <Switch label={`Enable ${p.name}`} checked={p.enabled} onChange={(v) => void setPlugin(p.id, v)} />
            </div>
          </li>
        ))}
      </ul>
      {info && !info.plugins.length ? <p className="faint">No plugins installed. Drop a folder with a plugin.json into <span className="mono">{info.dirs.plugins.at(-1)}</span>.</p> : null}

      <h3 className="ext__h">MCP servers</h3>
      <ul className="plist" aria-label="MCP servers">
        {info?.mcp.map((s) =>
          editing === s.id ? (
            <li key={s.id} className="pcard pcard--form"><McpForm initial={s} onDone={() => setEditing(null)} /></li>
          ) : (
            <li key={s.id} className="pcard" data-testid={`mcp-${s.id}`}>
              <div className="pcard__main">
                <strong>{s.name}</strong>
                <span className="faint mono pcard__url">{s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url}</span>
                {s.tools.length ? <span className="ext__tools">{s.tools.map((t) => <span key={t.name} className="chip mono" title={t.description}>{t.name}</span>)}</span> : null}
              </div>
              <div className="pcard__actions">
                <StatusDot status={s.status} error={s.error} />
                <button className="btn btn--sm" onClick={() => void testMcp(s.id)} disabled={!s.enabled}><Plug size={13} />Test</button>
                <button className="btn btn--sm" onClick={() => setEditing(s.id)}>Edit</button>
                <Switch label={`Enable ${s.name}`} checked={s.enabled} onChange={(v) => void setMcp(s.id, v)} />
                <button className="btn btn--ghost btn--icon btn--sm" aria-label={`Remove ${s.name}`} onClick={() => void removeMcp(s.id)}><Trash2 size={13} /></button>
              </div>
            </li>
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <div className="pcard pcard--form"><McpForm onDone={() => setEditing(null)} /></div>
      ) : (
        <div className="row">
          <button className="btn btn--primary" onClick={() => setEditing('new')}><Plus {...ICON} />Add MCP server</button>
          <button className="btn" onClick={() => void reload()} disabled={loading}>{loading ? <Loader2 size={13} className="spin" /> : <RefreshCw {...ICON} size={13} />}Reload plugins</button>
        </div>
      )}
    </div>
  );
}
