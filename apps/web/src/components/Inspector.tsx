import { type ReactNode } from 'react';
import { MousePointerClick, RotateCcw } from 'lucide-react';
import { type Clip, findItem, isClip, msToTicks, ticksToMs } from '@cutroom/core';
import { dispatch } from '../lib/actions';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';
import { NumberField } from './NumberField';
import { Tip } from './ui';

function Section({ title, children, onReset }: { title: string; children: ReactNode; onReset?: () => void }) {
  return (
    <section className="insp__sec">
      <header className="insp__head">
        <h3>{title}</h3>
        {onReset ? (
          <Tip label={`Reset ${title.toLowerCase()}`}>
            <button className="btn btn--ghost btn--icon btn--xs" aria-label={`Reset ${title}`} onClick={onReset}><RotateCcw size={12} strokeWidth={1.5} /></button>
          </Tip>
        ) : null}
      </header>
      <div className="insp__grid">{children}</div>
    </section>
  );
}

/** Speed as a rational: whole percentages are exact (150% → 3/2), so the engine's speed maths stays integer. */
function speedRatio(percent: number): { num: number; den: number } {
  const n = Math.round(percent);
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(n, 100);
  return { num: n / d, den: 100 / d };
}

/** Properties of the selected clip. Each field commits one undoable edit through the same engine the agents use. */
export function Inspector() {
  const seq = useApp((s) => s.sequence);
  const media = useApp((s) => s.media);
  const selection = useTimeline((s) => s.selection);
  const found = seq ? [...selection].map((id) => findItem(seq, id)).find((f) => f && isClip(f.item)) : undefined;
  if (!seq || !found || !isClip(found.item)) {
    return (
      <div className="empty empty--center">
        <MousePointerClick size={26} strokeWidth={1.25} />
        <p>Select a clip on the timeline to edit its properties.</p>
        <p className="faint">Position, scale, rotation, opacity, crop, speed and audio level live here.</p>
      </div>
    );
  }
  const clip: Clip = found.item;
  const kind = found.track.kind;
  const tb = seq.timebase;
  const t = clip.transform;
  const set = (patch: Record<string, unknown>, label: string) => void dispatch([{ type: 'setClipProps', clipId: clip.id, patch, linked: false }], label);
  const tf = (patch: Record<string, unknown>, label: string) => set({ transform: patch }, label);
  const speed = (clip.speed.num / clip.speed.den) * 100;
  const count = selection.size;

  return (
    <div className="insp" aria-label="Inspector">
      <div className="insp__clip">
        <strong title={clip.name ?? media[clip.mediaId]?.name}>{clip.name ?? media[clip.mediaId]?.name ?? clip.id}</strong>
        <span className="faint">{kind === 'video' ? 'Video clip' : 'Audio clip'}{count > 1 ? ` · ${count} selected, editing the first` : ''}</span>
      </div>

      {kind === 'video' ? (
        <>
          <Section title="Transform" onReset={() => tf({ position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0 }, 'Reset transform')}>
            <NumberField label="X" value={t.position.x} reset={0} decimals={0} step={1} unit="px" onCommit={(v) => tf({ position: { x: v } }, 'Position X')} />
            <NumberField label="Y" value={t.position.y} reset={0} decimals={0} step={1} unit="px" onCommit={(v) => tf({ position: { y: v } }, 'Position Y')} />
            <NumberField label="Scale" value={t.scale.x * 100} reset={100} decimals={1} step={0.5} min={1} max={800} unit="%" onCommit={(v) => tf({ scale: { x: v / 100, y: v / 100 } }, 'Scale')} />
            <NumberField label="Rotate" value={t.rotation} reset={0} decimals={1} step={0.5} unit="°" onCommit={(v) => tf({ rotation: v }, 'Rotation')} />
          </Section>
          <Section title="Composite" onReset={() => tf({ opacity: 1 }, 'Reset opacity')}>
            <NumberField label="Opacity" value={t.opacity * 100} reset={100} decimals={0} step={1} min={0} max={100} unit="%" onCommit={(v) => tf({ opacity: v / 100 }, 'Opacity')} />
          </Section>
          <Section title="Crop" onReset={() => tf({ crop: { left: 0, right: 0, top: 0, bottom: 0 } }, 'Reset crop')}>
            {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
              <NumberField key={side} label={side[0]!.toUpperCase() + side.slice(1)} value={t.crop[side] * 100} reset={0} decimals={1} step={0.5} min={0} max={95} unit="%" onCommit={(v) => tf({ crop: { [side]: v / 100 } }, `Crop ${side}`)} />
            ))}
          </Section>
        </>
      ) : (
        <Section title="Audio" onReset={() => set({ audio: { gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0 } }, 'Reset audio')}>
          <NumberField label="Gain" value={clip.audio.gainDb} reset={0} decimals={1} step={0.1} min={-96} max={24} unit="dB" onCommit={(v) => set({ audio: { gainDb: v } }, 'Clip gain')} />
          <NumberField label="Pan" value={clip.audio.pan * 100} reset={0} decimals={0} step={1} min={-100} max={100} unit="L–R" onCommit={(v) => set({ audio: { pan: v / 100 } }, 'Pan')} />
          <NumberField label="Fade in" value={ticksToMs(clip.audio.fadeIn, tb)} reset={0} decimals={0} step={5} min={0} unit="ms" onCommit={(v) => set({ audio: { fadeIn: msToTicks(v, tb) } }, 'Fade in')} />
          <NumberField label="Fade out" value={ticksToMs(clip.audio.fadeOut, tb)} reset={0} decimals={0} step={5} min={0} unit="ms" onCommit={(v) => set({ audio: { fadeOut: msToTicks(v, tb) } }, 'Fade out')} />
        </Section>
      )}

      <Section title="Speed" onReset={clip.speed.num === clip.speed.den ? undefined : () => void dispatch([{ type: 'setSpeed', clipId: clip.id, speed: { num: 1, den: 1 }, linked: true }], 'Reset speed')}>
        <NumberField label="Speed" value={speed} reset={100} decimals={0} step={1} min={10} max={1000} unit="%" onCommit={(v) => void dispatch([{ type: 'setSpeed', clipId: clip.id, speed: speedRatio(v), linked: true }], 'Change speed')} />
      </Section>
      <p className="insp__note faint">Every change is one undo step. Keyframes arrive with the motion tools.</p>
    </div>
  );
}
