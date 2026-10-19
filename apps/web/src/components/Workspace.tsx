import { type CSSProperties, useEffect } from 'react';
import { startTransport } from '../lib/transport';
import { usePersistedSize } from '../lib/layout';
import { useAgent } from '../store/agent';
import { useUi } from '../store/ui';
import { Splitter } from './Splitter';
import { SettingsDialog } from './SettingsDialog';
import { TopBar } from './TopBar';
import { Toasts } from './Toasts';
import { Viewer } from './Viewer';
import { AgentPanel, LeftPanel } from './Panels';
import { KeyboardLayer } from './CommandPalette';
import { TimelinePanel } from './Timeline';

// Bounds are functions so they track the window size.
const vh = () => window.innerHeight;
const LEFT = { min: () => 220, max: () => Math.min(520, window.innerWidth * 0.4) };
const RIGHT = { min: () => 300, max: () => Math.min(600, window.innerWidth * 0.45) };
const TIMELINE = { min: () => Math.round(vh() * 0.38), max: () => Math.round(vh() * 0.7) };

export function Workspace() {
  const rightOpen = useUi((s) => s.rightOpen);
  useEffect(() => startTransport(), []);
  useEffect(() => void useAgent.getState().load().catch(() => undefined), []);
  const [left, setLeft] = usePersistedSize('leftW', 280, LEFT.min, LEFT.max);
  const [right, setRight] = usePersistedSize('rightW', 380, RIGHT.min, RIGHT.max);
  const [timeline, setTimeline] = usePersistedSize('timelineH', Math.round(vh() * 0.4), TIMELINE.min, TIMELINE.max);

  const vars = { '--left-w': `${left}px`, '--right-w': `${right}px`, '--timeline-h': `${timeline}px` } as CSSProperties;
  return (
    <div className="app">
      <TopBar />
      <div className="workspace" style={vars} data-right={rightOpen ? 'open' : 'collapsed'}>
        <LeftPanel />
        <Splitter orientation="v" value={left} onChange={setLeft} label="Resize library panel" style={{ gridColumn: 2 }} />
        <Viewer />
        {rightOpen ? (
          <>
            <Splitter orientation="v" value={right} onChange={setRight} invert label="Resize agent panel" style={{ gridColumn: 4 }} />
            <AgentPanel />
          </>
        ) : null}
        <Splitter orientation="h" value={timeline} onChange={setTimeline} invert label="Resize timeline" />
        <TimelinePanel />
      </div>
      <Toasts />
      <SettingsDialog />
      <KeyboardLayer />
    </div>
  );
}
