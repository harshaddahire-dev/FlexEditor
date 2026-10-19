import * as Tabs from '@radix-ui/react-tabs';
import { PanelRightClose } from 'lucide-react';
import { useUi, type LeftTab } from '../store/ui';
import { MediaBin } from './MediaBin';
import { ICON, Tip } from './ui';

const TABS: { id: LeftTab; label: string; empty?: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'captions', label: 'Captions', empty: 'Caption styles and generated captions will be listed here.' },
  { id: 'effects', label: 'Effects', empty: 'Effects, LUTs and motion presets will be listed here.' },
  { id: 'transitions', label: 'Transitions', empty: 'GLSL transitions will be listed here.' },
  { id: 'skills', label: 'Skills', empty: 'Installed skills (YouTube retention cut, podcast cleanup, …) will be listed here.' },
];

export function LeftPanel() {
  const { leftTab, setLeftTab } = useUi();
  return (
    <aside className="panel panel--left" aria-label="Library">
      <Tabs.Root className="tabs__content" value={leftTab} onValueChange={(v) => setLeftTab(v as LeftTab)}>
        <Tabs.List className="tabs__list" aria-label="Library sections">
          {TABS.map((t) => (
            <Tabs.Trigger key={t.id} className="tabs__tab" value={t.id}>{t.label}</Tabs.Trigger>
          ))}
        </Tabs.List>
        {TABS.map((t) => (
          <Tabs.Content key={t.id} className="tabs__content" value={t.id}>
            {t.id === 'media' ? <MediaBin /> : <div className="empty"><p>{t.empty}</p></div>}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </aside>
  );
}

export function AgentPanel() {
  const toggle = useUi((s) => s.toggleRight);
  return (
    <aside className="panel panel--right" aria-label="Agent" style={{ borderLeft: '1px solid var(--line)' }}>
      <div className="panel__head">
        <span className="panel__title">Agent</span>
        <span className="spacer" />
        <Tip label="Hide agent panel">
          <button className="btn btn--ghost btn--icon btn--sm" aria-label="Hide agent panel" onClick={toggle}><PanelRightClose {...ICON} /></button>
        </Tip>
      </div>
      <div className="empty">
        <p>Editing agents are not connected yet.</p>
        <p className="faint">Model providers, the Director and specialists land in later build steps.</p>
      </div>
    </aside>
  );
}
