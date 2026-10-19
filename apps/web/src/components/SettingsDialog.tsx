import { useEffect, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { equalsR, type Rational } from '@cutroom/core';
import { api } from '../lib/api';
import { FPS_PRESETS, formatFps } from '../lib/format';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { ProvidersTab } from './ProvidersTab';
import { Modal } from './ui';

function ProjectTab() {
  const project = useApp((s) => s.project);
  const rescan = useApp((s) => s.rescan);
  const [w, setW] = useState('');
  const [h, setH] = useState('');
  const [fps, setFps] = useState<Rational | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!project) return;
    setW(String(project.settings.width));
    setH(String(project.settings.height));
    setFps(project.settings.fps);
  }, [project]);
  if (!project || !fps) return <p className="muted">No project is open.</p>;

  const known = FPS_PRESETS.some((p) => equalsR(p.value, fps));
  const dirty = Number(w) !== project.settings.width || Number(h) !== project.settings.height || !equalsR(fps, project.settings.fps);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.updateSettings({ width: Number(w), height: Number(h), fps });
            setMsg({ ok: true, text: 'Sequence settings saved.' });
          } catch (err) {
            setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
          }
        }}
      >
        <label className="label" htmlFor="set-w">Width</label>
        <input id="set-w" className="input input--mono" inputMode="numeric" value={w} onChange={(e) => setW(e.target.value)} />
        <label className="label" htmlFor="set-h">Height</label>
        <input id="set-h" className="input input--mono" inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} />
        <label className="label" htmlFor="set-fps">Frame rate</label>
        <select
          id="set-fps"
          className="input"
          value={known ? `${fps.num}/${fps.den}` : 'custom'}
          onChange={(e) => {
            const p = FPS_PRESETS.find((x) => `${x.value.num}/${x.value.den}` === e.target.value);
            if (p) setFps(p.value);
          }}
        >
          {FPS_PRESETS.map((p) => (
            <option key={p.label} value={`${p.value.num}/${p.value.den}`}>{p.label} fps</option>
          ))}
          {!known ? <option value="custom">{formatFps(fps)} fps (from footage)</option> : null}
        </select>
        <span className="label">Audio</span>
        <span className="mono">{project.settings.sampleRate / 1000} kHz</span>
        <span />
        <div className="row">
          <button className="btn btn--primary" type="submit" disabled={!dirty}>Save</button>
          {msg ? <span style={{ color: msg.ok ? 'var(--success)' : 'var(--danger)' }} role="status">{msg.text}</span> : null}
        </div>
      </form>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <span className="section-title">Folder</span>
        <dl className="dl">
          <dt className="label">Path</dt>
          <dd>{project.folder}</dd>
          <dt className="label">Media</dt>
          <dd>{project.mediaCount}</dd>
        </dl>
        <div className="row">
          <button className="btn" onClick={() => void rescan()}>Rescan folder</button>
          {project.ignoredCount > 0 ? (
            <button className="btn" onClick={() => void rescan(true)}>Re-include {project.ignoredCount} removed file{project.ignoredCount === 1 ? '' : 's'}</button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function SystemTab() {
  const health = useApp((s) => s.health);
  const recheck = useApp((s) => s.recheckFfmpeg);
  const { theme, setTheme } = useUi();
  if (!health) return null;
  const { ffmpeg } = health;
  const pill = (name: string, ok: boolean) => (
    <span key={name} className={`pill ${ok ? 'pill--ok' : 'pill--bad'}`}>{name}</span>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <span className="section-title">Appearance</span>
        <div className="row">
          <label className="label" htmlFor="theme">Theme</label>
          <select id="theme" className="input" value={theme} onChange={(e) => setTheme(e.target.value === 'light' ? 'light' : 'dark')}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
      </section>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <span className="section-title">FFmpeg</span>
        <dl className="dl">
          <dt className="label">ffmpeg</dt>
          <dd>{ffmpeg.ffmpeg ? `${ffmpeg.ffmpeg.version} — ${ffmpeg.ffmpeg.path}` : 'not found'}</dd>
          <dt className="label">ffprobe</dt>
          <dd>{ffmpeg.ffprobe ? `${ffmpeg.ffprobe.version} — ${ffmpeg.ffprobe.path}` : 'not found'}</dd>
          <dt className="label">Encoders</dt>
          <dd className="chips">{Object.entries(ffmpeg.encoders).map(([k, v]) => pill(k, v))}</dd>
          <dt className="label">Filters</dt>
          <dd className="chips">{Object.entries(ffmpeg.filters).map(([k, v]) => pill(k, v))}</dd>
          <dt className="label">Data folder</dt>
          <dd>{health.dataDir}</dd>
          <dt className="label">Version</dt>
          <dd>{health.version}</dd>
        </dl>
        {ffmpeg.warnings.length ? (
          <div className="callout callout--warn">
            <ul>{ffmpeg.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        ) : null}
        <div><button className="btn" onClick={() => void recheck()}>Re-check FFmpeg</button></div>
      </section>
    </div>
  );
}

export function SettingsDialog() {
  const { settingsOpen, settingsTab, closeSettings, openSettings } = useUi();
  return (
    <Modal open={settingsOpen} onOpenChange={(o) => (o ? openSettings() : closeSettings())} title="Settings" width={620}>
      <Tabs.Root value={settingsTab} onValueChange={(v) => openSettings(v === 'system' ? 'system' : v === 'providers' ? 'providers' : 'project')}>
        <Tabs.List className="tabs__list" style={{ marginBottom: 'var(--s-4)' }}>
          <Tabs.Trigger className="tabs__tab" value="project">Project</Tabs.Trigger>
          <Tabs.Trigger className="tabs__tab" value="providers">Providers</Tabs.Trigger>
          <Tabs.Trigger className="tabs__tab" value="system">System</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="project"><ProjectTab /></Tabs.Content>
        <Tabs.Content value="providers"><ProvidersTab /></Tabs.Content>
        <Tabs.Content value="system"><SystemTab /></Tabs.Content>
      </Tabs.Root>
    </Modal>
  );
}
