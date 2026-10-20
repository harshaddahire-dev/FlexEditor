import { useMemo, useRef, useState, type DragEvent } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { AlertTriangle, Film, FolderUp, Image as ImageIcon, LayoutGrid, List, MoreHorizontal, Music, Plus, Search, X } from 'lucide-react';
import type { JobInfo, Media } from '@cutroom/core';
import { mediaUrl } from '../lib/api';
import { collectDropped, collectFromInput } from '../lib/dropped';
import { describeVideo, formatDuration } from '../lib/format';
import { jobsForMedia, useApp } from '../store/app';
import { placeSelectedMedia } from '../lib/actions';
import { RelinkDialog } from './RelinkDialog';
import { MEDIA_MIME } from './Timeline';
import { StatusDots } from './StatusDots';
import { ICON, Tip } from './ui';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function TypeIcon({ type }: { type: Media['type'] }) {
  if (type === 'audio') return <Music {...ICON} />;
  if (type === 'image') return <ImageIcon {...ICON} />;
  return <Film {...ICON} />;
}

function metaLine(m: Media): string {
  if (m.type === 'video') return describeVideo(m);
  if (m.type === 'audio') return `${m.audioChannels} ch · ${(m.audio?.sampleRate ?? 48000) / 1000} kHz`;
  return m.video ? `${m.video.width}×${m.video.height}` : '';
}

function proxyProgress(jobs: JobInfo[]): number | undefined {
  return jobs.find((j) => j.kind === 'proxy')?.progress;
}

/**
 * The "…" menu of a bin item. The item is an `option` of a listbox, which cannot contain a button, so the visible "…" is a
 * mouse affordance only (hidden from assistive tech); the same menu opens from the keyboard with the Menu key or Shift+F10.
 */
function useItemMenu() {
  const [open, set] = useState(false);
  return { open, set, onKeyDown: (e: React.KeyboardEvent) => (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && (e.preventDefault(), set(true)) };
}

function ItemMenu({ media, onRelink, open, onOpenChange }: { media: Media; onRelink: () => void; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { removeMedia, reproxy } = useApp();
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <span className="tile__more" role="presentation" aria-hidden="true" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <MoreHorizontal {...ICON} />
        </span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
          {media.missing ? <DropdownMenu.Item className="menu__item" onSelect={onRelink}>Relink…</DropdownMenu.Item> : null}
          {media.type === 'video' ? (
            <DropdownMenu.Item className="menu__item" disabled={media.missing} onSelect={() => void reproxy(media.id)}>
              Regenerate proxy
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Separator className="menu__sep" />
          <DropdownMenu.Item className="menu__item" onSelect={() => void removeMedia(media.id)}>
            Remove from project
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

interface ItemProps {
  media: Media;
  selected: boolean;
  duration: string;
  progress?: number;
  onSelect: () => void;
  onRelink: () => void;
}

function Tile({ media, selected, duration, progress, onSelect, onRelink }: ItemProps) {
  const warn = media.warnings.length > 0;
  const menu = useItemMenu();
  return (
    <div className="tile" role="option" aria-selected={selected} tabIndex={0} data-media-id={media.id} draggable={!media.missing} onDragStart={(e) => { e.dataTransfer.setData(MEDIA_MIME, media.id); e.dataTransfer.effectAllowed = 'copy'; }} onDoubleClick={() => { onSelect(); queueMicrotask(() => placeSelectedMedia('insert')); }} onClick={onSelect} onKeyDown={(e) => { menu.onKeyDown(e); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}>
      <div className="tile__thumb">
        {media.status.poster === 'done' ? (
          <img src={mediaUrl(media.id, 'poster', media.mtimeMs)} alt="" draggable={false} />
        ) : media.status.poster === 'queued' || media.status.poster === 'running' ? (
          <div className="skeleton" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <TypeIcon type={media.type} />
        )}
        {media.type !== 'image' ? <span className="tile__dur">{duration}</span> : null}
        {progress !== undefined && progress < 1 ? <span className="tile__progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span> : null}
        {media.missing ? <div className="tile__missing">Missing</div> : null}
      </div>
      <span className="tile__name" title={media.path}>{media.name}</span>
      <span className="tile__meta">
        <StatusDots media={media} progress={progress} />
        {warn ? (
          <Tip label={media.warnings.join('\n')}>
            <span style={{ color: 'var(--warn)', display: 'inline-flex' }} aria-label={`${media.warnings.length} warning${media.warnings.length === 1 ? '' : 's'}`}><AlertTriangle size={12} strokeWidth={1.5} /></span>
          </Tip>
        ) : null}
      </span>
      <ItemMenu media={media} onRelink={onRelink} open={menu.open} onOpenChange={menu.set} />
    </div>
  );
}

function Row({ media, selected, duration, progress, onSelect, onRelink }: ItemProps) {
  const menu = useItemMenu();
  return (
    <div className="rowitem" role="option" aria-selected={selected} tabIndex={0} data-media-id={media.id} draggable={!media.missing} onDragStart={(e) => { e.dataTransfer.setData(MEDIA_MIME, media.id); e.dataTransfer.effectAllowed = 'copy'; }} onDoubleClick={() => { onSelect(); queueMicrotask(() => placeSelectedMedia('insert')); }} onClick={onSelect} onKeyDown={(e) => { menu.onKeyDown(e); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}>
      <span style={{ color: media.missing ? 'var(--danger)' : 'var(--text-3)', display: 'inline-flex' }}><TypeIcon type={media.type} /></span>
      <span className="rowitem__name" title={`${media.path}${metaLine(media) ? ` — ${metaLine(media)}` : ''}`}>{media.name}</span>
      <span className="mono faint" style={media.missing ? { color: 'var(--danger)' } : undefined}>{media.missing ? 'missing' : media.type === 'image' ? '' : duration}</span>
      <StatusDots media={media} progress={progress} />
      <ItemMenu media={media} onRelink={onRelink} open={menu.open} onOpenChange={menu.set} />
    </div>
  );
}

export function MediaBin() {
  const media = useApp((s) => s.media);
  const jobs = useApp((s) => s.jobs);
  const project = useApp((s) => s.project);
  const selectedId = useApp((s) => s.selectedMediaId);
  const { selectMedia, uploadFiles, rescan } = useApp();

  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('cutroom.binView') === 'list' ? 'list' : 'grid'));
  const [filter, setFilter] = useState('');
  const [dragging, setDragging] = useState(false);
  const [relinking, setRelinking] = useState<Media | null>(null);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return Object.values(media)
      .filter((m) => !q || m.name.toLowerCase().includes(q))
      .sort((a, b) => collator.compare(a.name, b.name));
  }, [media, filter]);

  if (!project) return null;
  const fps = project.settings.fps;

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const pending = await collectDropped(e.dataTransfer);
    if (pending.length) void uploadFiles(pending);
  };

  const setViewMode = (v: 'grid' | 'list') => {
    setView(v);
    try {
      localStorage.setItem('cutroom.binView', v);
    } catch {
      /* ignore */
    }
  };

  const total = Object.keys(media).length;

  return (
    <div
      className="bin"
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="bin__bar">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="btn"><Plus {...ICON} />Import</button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
              <DropdownMenu.Item className="menu__item" onSelect={() => fileInput.current?.click()}>Files…</DropdownMenu.Item>
              <DropdownMenu.Item className="menu__item" onSelect={() => folderInput.current?.click()}><FolderUp {...ICON} />Folder…</DropdownMenu.Item>
              <DropdownMenu.Separator className="menu__sep" />
              <DropdownMenu.Item className="menu__item" onSelect={() => void rescan()}>Rescan project folder</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <div className="row" style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <Search size={14} strokeWidth={1.5} style={{ position: 'absolute', left: 8, color: 'var(--text-3)', pointerEvents: 'none' }} />
          <input className="input" style={{ width: '100%', paddingLeft: 26, paddingRight: filter ? 26 : 8 }} placeholder="Filter" aria-label="Filter media" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filter ? (
            <button className="btn btn--ghost btn--icon btn--sm" style={{ position: 'absolute', right: 2 }} aria-label="Clear filter" onClick={() => setFilter('')}><X size={14} strokeWidth={1.5} /></button>
          ) : null}
        </div>
        <ToggleGroup.Root className="seg" type="single" value={view} onValueChange={(v) => v && setViewMode(v as 'grid' | 'list')} aria-label="Bin view">
          <ToggleGroup.Item className="seg__btn" value="grid" aria-label="Grid view" style={{ padding: '0 6px' }}><LayoutGrid size={14} strokeWidth={1.5} /></ToggleGroup.Item>
          <ToggleGroup.Item className="seg__btn" value="list" aria-label="List view" style={{ padding: '0 6px' }}><List size={14} strokeWidth={1.5} /></ToggleGroup.Item>
        </ToggleGroup.Root>
      </div>

      <input ref={fileInput} type="file" multiple hidden accept="video/*,audio/*,image/*,.mkv,.mxf,.mts,.m2ts,.ts,.flac,.opus,.aif,.aiff" onChange={(e) => { const p = collectFromInput(e.target.files); e.target.value = ''; if (p.length) void uploadFiles(p); }} />
      <input ref={folderInput} type="file" hidden multiple {...({ webkitdirectory: '' } as object)} onChange={(e) => { const p = collectFromInput(e.target.files); e.target.value = ''; if (p.length) void uploadFiles(p); }} />

      <div className={`bin__scroll ${view === 'list' ? 'bin__list-scroll' : ''}`}>
        {total === 0 ? (
          <div className="empty">
            <p>No media in this project yet.</p>
            <p className="faint">Drop footage anywhere on this panel, or import files or a folder.</p>
            <button className="btn btn--primary" onClick={() => fileInput.current?.click()}><Plus {...ICON} />Import files</button>
          </div>
        ) : items.length === 0 ? (
          <div className="empty">No media matches “{filter}”.</div>
        ) : (
          <div className={view === 'grid' ? 'bin__grid' : 'bin__list'} role="listbox" aria-label="Media" aria-orientation={view === 'grid' ? undefined : 'vertical'}>
            {items.map((m) => {
              const mediaJobs = jobsForMedia(jobs, m.id);
              const props: ItemProps = {
                media: m,
                selected: m.id === selectedId,
                duration: formatDuration(m.duration, m.fps ?? fps),
                progress: proxyProgress(mediaJobs),
                onSelect: () => selectMedia(m.id),
                onRelink: () => setRelinking(m),
              };
              return view === 'grid' ? <Tile key={m.id} {...props} /> : <Row key={m.id} {...props} />;
            })}
          </div>
        )}
      </div>

      {dragging ? <div className="bin__drop">Drop to import into this project</div> : null}
      <RelinkDialog media={relinking} onClose={() => setRelinking(null)} />
    </div>
  );
}
