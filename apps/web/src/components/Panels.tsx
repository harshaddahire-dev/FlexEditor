import * as Tabs from '@radix-ui/react-tabs';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Ellipsis, Plus, X } from 'lucide-react';
import { useAgent } from '../store/agent';
import { useUi, type LeftTab, type RightTab } from '../store/ui';
import { AgentSetup } from './AgentSetup';
import { Inspector } from './Inspector';
import { CaptionsPanel, EffectsPanel, TransitionsPanel } from './LibraryPanels';
import { MediaBin } from './MediaBin';
import { SkillsPanel } from './SkillsPanel';
import { TranscriptPanel } from './TranscriptPanel';
import { ICON, Tip } from './ui';

const TABS: { id: LeftTab; label: string; empty?: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'captions', label: 'Captions', empty: 'Caption styles and generated captions will be listed here.' },
  { id: 'effects', label: 'Effects', empty: 'Effects, LUTs and motion presets will be listed here.' },
  { id: 'transitions', label: 'Transitions', empty: 'GLSL transitions will be listed here.' },
  { id: 'skills', label: 'Skills' },
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
            {t.id === 'media' ? <MediaBin /> : t.id === 'transcript' ? <TranscriptPanel /> : t.id === 'captions' ? <CaptionsPanel /> : t.id === 'effects' ? <EffectsPanel /> : t.id === 'transitions' ? <TransitionsPanel /> : t.id === 'skills' ? <SkillsPanel /> : <div className="empty"><p>{t.empty}</p></div>}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </aside>
  );
}

const RIGHT_TABS: { id: RightTab; label: string }[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'inspector', label: 'Inspector' },
];

/** Right side, full height: the agent chat (and the clip Inspector) as one tall column. */
export function AgentPanel() {
  const { toggleRight, rightTab, setRightTab, openSettings, setLeftTab } = useUi();
  const busy = useAgent((s) => !!s.activeRunId);
  const hasChat = useAgent((s) => s.turns.length > 0);
  const clearChat = useAgent((s) => s.clearChat);
  return (
    <aside className="panel panel--right" aria-label="Inspector and agent">
      <Tabs.Root className="tabs__content" value={rightTab} onValueChange={(v) => setRightTab(v as RightTab)}>
        <div className="agenthead">
          <Tabs.List className="agenthead__tabs" aria-label="Right panel">
            {RIGHT_TABS.map((t) => (
              <Tabs.Trigger key={t.id} className="agenthead__tab" value={t.id}>{t.label}</Tabs.Trigger>
            ))}
          </Tabs.List>
          <span className="spacer" />
          {rightTab === 'agent' ? (
            <>
              <Tip label={busy ? 'Wait for the current run to finish' : 'New chat'}>
                <button className="btn btn--ghost btn--icon btn--sm" aria-label="New chat" disabled={busy || !hasChat} onClick={() => void clearChat()}><Plus {...ICON} /></button>
              </Tip>
              <DropdownMenu.Root>
                <Tip label="More">
                  <DropdownMenu.Trigger asChild>
                    <button className="btn btn--ghost btn--icon btn--sm" aria-label="Agent options"><Ellipsis {...ICON} /></button>
                  </DropdownMenu.Trigger>
                </Tip>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
                    <DropdownMenu.Item className="menu__item" onSelect={() => openSettings('providers')}>Providers…</DropdownMenu.Item>
                    <DropdownMenu.Item className="menu__item" onSelect={() => openSettings('extensions')}>Plugins &amp; MCP…</DropdownMenu.Item>
                    <DropdownMenu.Item className="menu__item" onSelect={() => setLeftTab('skills')}>Show skills</DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </>
          ) : null}
          <Tip label="Hide panel">
            <button className="btn btn--ghost btn--icon btn--sm" aria-label="Hide agent panel" onClick={toggleRight}><X {...ICON} /></button>
          </Tip>
        </div>
        <Tabs.Content className="tabs__content tabs__scroll" value="inspector"><Inspector /></Tabs.Content>
        <Tabs.Content className="tabs__content" value="agent"><AgentSetup /></Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
