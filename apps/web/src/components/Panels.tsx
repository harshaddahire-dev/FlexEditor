import * as Tabs from '@radix-ui/react-tabs';
import { PanelRightClose } from 'lucide-react';
import { useUi, type LeftTab, type RightTab } from '../store/ui';
import { AgentSetup } from './AgentSetup';
import { Inspector } from './Inspector';
import { CaptionsPanel, EffectsPanel, TransitionsPanel } from './LibraryPanels';
import { MediaBin } from './MediaBin';
import { TranscriptPanel } from './TranscriptPanel';
import { ICON, Tip } from './ui';

const TABS: { id: LeftTab; label: string; empty?: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'transcript', label: 'Transcript' },
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
            {t.id === 'media' ? <MediaBin /> : t.id === 'transcript' ? <TranscriptPanel /> : t.id === 'captions' ? <CaptionsPanel /> : t.id === 'effects' ? <EffectsPanel /> : t.id === 'transitions' ? <TransitionsPanel /> : <div className="empty"><p>{t.empty}</p></div>}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </aside>
  );
}

const RIGHT_TABS: { id: RightTab; label: string }[] = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'agent', label: 'Agent' },
];

/** Right side: the clip Inspector, and the agent chat (arrives with the agent runtime). */
export function AgentPanel() {
  const { toggleRight, rightTab, setRightTab } = useUi();
  return (
    <aside className="panel panel--right" aria-label="Inspector and agent">
      <Tabs.Root className="tabs__content" value={rightTab} onValueChange={(v) => setRightTab(v as RightTab)}>
        <div className="tabs__bar">
          <Tabs.List className="tabs__list tabs__list--bar" aria-label="Right panel">
            {RIGHT_TABS.map((t) => (
              <Tabs.Trigger key={t.id} className="tabs__tab" value={t.id}>{t.label}</Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tip label="Hide panel">
            <button className="btn btn--ghost btn--icon btn--sm" aria-label="Hide agent panel" onClick={toggleRight}><PanelRightClose {...ICON} /></button>
          </Tip>
        </div>
        <Tabs.Content className="tabs__content tabs__scroll" value="inspector"><Inspector /></Tabs.Content>
        <Tabs.Content className="tabs__content" value="agent"><AgentSetup /></Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
