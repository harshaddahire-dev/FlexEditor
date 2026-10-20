import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { ChevronDown, Download, PanelRight, Redo2, Settings, Undo2 } from 'lucide-react';
import { useApp } from '../store/app';
import { useExport } from '../store/export';
import { useUi, type Workspace } from '../store/ui';
import { Logo } from './Logo';
import { UpdatePill } from './UpdatePill';
import { ICON, Tip } from './ui';

const WORKSPACES: { id: Workspace; label: string }[] = [
  { id: 'edit', label: 'Edit' },
  { id: 'audio', label: 'Audio' },
  { id: 'captions', label: 'Captions' },
  { id: 'color', label: 'Color' },
];

export function TopBar() {
  const project = useApp((s) => s.project);
  const sequence = useApp((s) => s.sequence);
  const openRender = useExport((s) => s.openDialog);
  const wsConnected = useApp((s) => s.wsConnected);
  const closeProject = useApp((s) => s.closeProject);
  const rescan = useApp((s) => s.rescan);
  const { workspace, setWorkspace, rightOpen, toggleRight, openSettings } = useUi();
  const history = useApp((s) => s.history);
  const { undo, redo } = useApp();
  const lastUndo = history?.undo[history.undo.length - 1]?.label;
  const nextRedo = history?.redo[history.redo.length - 1]?.label;

  return (
    <header className="topbar">
      <Logo size={22} />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="btn btn--ghost topbar__project" aria-label={`${project?.name ?? 'Project'} — project menu`}>
            <span className="topbar__name">{project?.name}</span>
            <ChevronDown {...ICON} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
            <DropdownMenu.Item className="menu__item" onSelect={() => void rescan()}>Rescan folder</DropdownMenu.Item>
            <DropdownMenu.Item className="menu__item" onSelect={() => openSettings('project')}>Project settings…</DropdownMenu.Item>
            <DropdownMenu.Separator className="menu__sep" />
            <DropdownMenu.Item className="menu__item" onSelect={() => void closeProject()}>Close project</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Tip label={wsConnected ? 'Live connection to the local server' : 'Reconnecting to the local server…'}>
        <span className="row faint" role="status" aria-label={wsConnected ? 'Connected' : 'Reconnecting'}>
          <span className="dot" data-state={wsConnected ? 'done' : 'queued'} />
          {wsConnected ? 'Autosave on' : 'Reconnecting…'}
        </span>
      </Tip>

      <span className="topbar__sep" />
      <Tip label={history?.canUndo ? `Undo ${lastUndo ?? ''}` : 'Nothing to undo'}>
        <button className="btn btn--ghost btn--icon" aria-label="Undo" disabled={!history?.canUndo} onClick={() => void undo()}><Undo2 {...ICON} /></button>
      </Tip>
      <Tip label={history?.canRedo ? `Redo ${nextRedo ?? ''}` : 'Nothing to redo'}>
        <button className="btn btn--ghost btn--icon" aria-label="Redo" disabled={!history?.canRedo} onClick={() => void redo()}><Redo2 {...ICON} /></button>
      </Tip>

      <span className="spacer" />
      <ToggleGroup.Root className="seg" type="single" value={workspace} onValueChange={(v) => v && setWorkspace(v as Workspace)} aria-label="Workspace">
        {WORKSPACES.map((w) => (
          <ToggleGroup.Item key={w.id} className="seg__btn" value={w.id}>{w.label}</ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
      <span className="spacer" />

      <UpdatePill />
      <Tip label="Render the timeline to a video or audio file">
        <button className="btn" disabled={!sequence} onClick={openRender}><Download {...ICON} />Render</button>
      </Tip>
      <Tip label={rightOpen ? 'Hide agent panel' : 'Show agent panel'}>
        <button className="btn btn--ghost btn--icon" aria-label="Toggle agent panel" aria-pressed={rightOpen} onClick={toggleRight}><PanelRight {...ICON} /></button>
      </Tip>
      <Tip label="Settings">
        <button className="btn btn--ghost btn--icon" aria-label="Settings" onClick={() => openSettings()}><Settings {...ICON} /></button>
      </Tip>
    </header>
  );
}
