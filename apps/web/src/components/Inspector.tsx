import { type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronLeft, ChevronRight, Eye, EyeOff, MousePointerClick, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  CAPTION_STYLES,
  type Clip,
  type CaptionItem,
  EFFECTS,
  type EffectInstance,
  type Keyframe,
  type Op,
  type ParamDef,
  captionText,
  defaultParams,
  effectDef,
  evaluateKeyframes,
  findItem,
  frameTicks,
  isCaption,
  isClip,
  msToTicks,
  retimeWords,
  ticksToMs,
} from '@cutroom/core';
import { dispatch } from '../lib/actions';
import { useApp } from '../store/app';
import { useTimeline } from '../store/timeline';
import { NumberField } from './NumberField';
import { Tip } from './ui';

function Section({ title, children, onReset, actions }: { title: string; children: ReactNode; onReset?: () => void; actions?: ReactNode }) {
  return (
    <section className="insp__sec">
      <header className="insp__head">
        <h3>{title}</h3>
        <span className="insp__actions">
          {actions}
          {onReset ? (
            <Tip label={`Reset ${title.toLowerCase()}`}>
              <button className="btn btn--ghost btn--icon btn--xs" aria-label={`Reset ${title}`} onClick={onReset}><RotateCcw size={12} strokeWidth={1.5} /></button>
            </Tip>
          ) : null}
        </span>
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

const kfAt = (list: readonly Keyframe[] | undefined, rel: number, frame: number): Keyframe | undefined => list?.find((k) => Math.abs(k.time - rel) < frame / 2);

type Interp = 'linear' | 'ease' | 'hold';
const EASE: Partial<Keyframe> = { interpolation: 'bezier', bezier: undefined };

const EASE_NEXT: Record<Interp, Interp> = { linear: 'ease', ease: 'hold', hold: 'linear' };
const EASE_LABEL: Record<Interp, string> = { linear: 'Linear', ease: 'Ease', hold: 'Hold' };

/** Diamond at the right of an animatable field: filled on a keyframe, outlined between keyframes, plain when static. */
function Diamond({ state, interp, disabled, onToggle, onEase, onPrev, onNext }: { state: 'static' | 'animated' | 'on'; interp: Interp; disabled: boolean; onToggle(): void; onEase(i: Interp): void; onPrev?: () => void; onNext?: () => void }) {
  return (
    <span className="kf" data-state={state}>
      {state !== 'static' && onPrev ? <button className="kf__nav" aria-label="Previous keyframe" onClick={onPrev}><ChevronLeft size={10} /></button> : null}
      <Tip label={disabled ? 'Move the playhead onto this clip to add a keyframe' : state === 'on' ? 'Remove keyframe' : 'Add keyframe at the playhead'}>
        <button className="kf__btn" aria-label={state === 'on' ? 'Remove keyframe' : 'Add keyframe'} aria-pressed={state === 'on'} disabled={disabled} onClick={onToggle}>
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden><path d="M6 1 11 6 6 11 1 6Z" /></svg>
        </button>
      </Tip>
      {state === 'on' ? (
        <Tip label={`Easing out of this keyframe: ${EASE_LABEL[interp]} — click to change`}>
          <button className="kf__ease" aria-label={`Easing: ${EASE_LABEL[interp]}`} onClick={() => onEase(EASE_NEXT[interp])}>{EASE_LABEL[interp][0]}</button>
        </Tip>
      ) : null}
      {state !== 'static' && onNext ? <button className="kf__nav" aria-label="Next keyframe" onClick={onNext}><ChevronRight size={10} /></button> : null}
    </span>
  );
}

interface AnimatedProps {
  clip: Clip;
  label: string;
  /** Keyframe paths this field drives (scale drives both axes). */
  props: string[];
  /** Static value in display units. */
  value: number;
  /** display units → one stored value per path. */
  toStored(v: number): number[];
  fromStored(v: number): number;
  onStatic(v: number): void;
  reset?: number;
  decimals?: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
}

/** A NumberField that can be keyframed: while animated, edits write a keyframe at the playhead and the value follows it. */
function AnimatedField({ clip, label, props, value, toStored, fromStored, onStatic, ...rest }: AnimatedProps) {
  const playhead = useTimeline((s) => s.playhead);
  const seq = useApp((s) => s.sequence)!;
  const frame = frameTicks(seq.timebase);
  const lead = props[0]!;
  const list = clip.keyframes[lead];
  const inside = playhead >= clip.start && playhead < clip.start + clip.duration;
  const rel = Math.min(clip.duration - frame, Math.max(0, Math.round((playhead - clip.start) / frame) * frame));
  const on = kfAt(list, rel, frame);
  const state = on ? 'on' : list?.length ? 'animated' : 'static';
  const shown = list?.length ? fromStored(evaluateKeyframes(list, rel, toStored(value)[0]!)) : value;

  const write = (v: number, base?: Keyframe): Op[] => {
    const stored = toStored(v);
    return props.map((p, i) => ({ type: 'addKeyframe' as const, clipId: clip.id, prop: p, keyframe: { time: rel, value: stored[i]!, interpolation: base?.interpolation ?? 'linear', ...(base?.bezier ? { bezier: base.bezier } : {}) } }));
  };
  const setInterp = (i: Interp) => {
    if (!on) return;
    const ops: Op[] = props.flatMap((p): Op[] => {
      const k = clip.keyframes[p]?.find((x) => Math.abs(x.time - on.time) < frame / 2);
      if (!k) return [];
      const next = i === 'linear' ? { interpolation: 'linear' as const } : i === 'hold' ? { interpolation: 'hold' as const } : { ...EASE, interpolation: 'bezier' as const };
      return [{ type: 'addKeyframe', clipId: clip.id, prop: p, keyframe: { time: k.time, value: k.value, ...next } as Extract<Op, { type: 'addKeyframe' }>['keyframe'] }];
    });
    if (ops.length) void dispatch(ops, 'Keyframe easing');
  };
  const go = (dir: 1 | -1) => {
    const times = (list ?? []).map((k) => clip.start + k.time);
    const target = dir > 0 ? times.find((t) => t > playhead + frame / 2) : [...times].reverse().find((t) => t < playhead - frame / 2);
    if (target !== undefined) useTimeline.getState().setPlayhead(target, seq);
  };

  return (
    <div className="afield">
      <NumberField
        label={label}
        value={shown}
        {...rest}
        onCommit={(v) => {
          if (list?.length) {
            if (inside) void dispatch(write(v, on), `${label} keyframe`);
          } else onStatic(v);
        }}
      />
      <Diamond
        state={state}
        interp={on ? (on.interpolation === 'hold' ? 'hold' : on.interpolation === 'bezier' ? 'ease' : 'linear') : 'linear'}
        disabled={!inside}
        onPrev={() => go(-1)}
        onNext={() => go(1)}
        onEase={setInterp}
        onToggle={() => {
          if (on) {
            void dispatch(props.map((p) => ({ type: 'removeKeyframe' as const, clipId: clip.id, prop: p, time: on.time })), 'Remove keyframe');
          } else void dispatch(write(shown), 'Add keyframe');
        }}
      />
    </div>
  );
}

function EffectCard({ clip, fx }: { clip: Clip; fx: EffectInstance }) {
  const def = effectDef(fx.type);
  const playhead = useTimeline((s) => s.playhead);
  const seq = useApp((s) => s.sequence)!;
  const frame = frameTicks(seq.timebase);
  const rel = Math.min(clip.duration - frame, Math.max(0, Math.round((playhead - clip.start) / frame) * frame));
  const set = (patch: Record<string, number>) => void dispatch([{ type: 'setEffect', clipId: clip.id, effectId: fx.id, params: patch }], `${def?.label ?? fx.type}`);
  return (
    <div className="fx" data-off={!fx.enabled}>
      <header className="fx__head">
        <Tip label={fx.enabled ? 'Turn off' : 'Turn on'}>
          <button className="btn btn--ghost btn--icon btn--xs" aria-label={`${fx.enabled ? 'Disable' : 'Enable'} ${def?.label ?? fx.type}`} aria-pressed={fx.enabled} onClick={() => void dispatch([{ type: 'setEffect', clipId: clip.id, effectId: fx.id, enabled: !fx.enabled }], 'Toggle effect')}>
            {fx.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
        </Tip>
        <strong className="fx__name">{def?.label ?? fx.type}</strong>
        <Tip label="Remove effect">
          <button className="btn btn--ghost btn--icon btn--xs" aria-label={`Remove ${def?.label ?? fx.type}`} onClick={() => void dispatch([{ type: 'removeEffect', clipId: clip.id, effectId: fx.id }], 'Remove effect')}><Trash2 size={12} /></button>
        </Tip>
      </header>
      <div className="insp__grid">
        {(def?.params ?? []).map((p: ParamDef) => {
          const stored = fx.params[p.key];
          const v = typeof stored === 'number' ? stored : p.default;
          if (p.kind === 'choice') {
            return (
              <label key={p.key} className="nf nf--select">
                <span className="nf__label">{p.label}</span>
                <select className="nf__input" value={String(Math.round(v))} aria-label={p.label} onChange={(e) => set({ [p.key]: Number(e.target.value) })}>
                  {p.options!.map((o, i) => <option key={o} value={i}>{o}</option>)}
                </select>
              </label>
            );
          }
          const path = `effect:${fx.id}.${p.key}`;
          return (
            <AnimatedField
              key={p.key}
              clip={clip}
              label={p.label}
              props={[path]}
              value={v}
              toStored={(x) => [x]}
              fromStored={(x) => x}
              onStatic={(x) => set({ [p.key]: x })}
              reset={p.default}
              min={p.min}
              max={p.max}
              step={p.step}
              decimals={p.step >= 1 ? 0 : p.step >= 0.1 ? 1 : 2}
              unit={p.unit}
            />
          );
        })}
      </div>
      <span className="sr-only">{rel}</span>
    </div>
  );
}

function CaptionInspector({ cap }: { cap: CaptionItem }) {
  const seq = useApp((s) => s.sequence)!;
  const f = frameTicks(seq.timebase);
  return (
    <div className="insp" aria-label="Inspector">
      <div className="insp__clip">
        <strong>Caption</strong>
        <span className="faint">{(cap.start / seq.timebase.rate).toFixed(2)} s · {(cap.duration / seq.timebase.rate).toFixed(2)} s long</span>
      </div>
      <Section title="Text">
        <textarea
          className="input insp__text"
          rows={3}
          key={cap.id + captionText(cap)}
          defaultValue={captionText(cap)}
          aria-label="Caption text"
          onBlur={(e) => {
            const t = e.target.value.trim();
            if (t && t !== captionText(cap)) void dispatch([{ type: 'updateCaption', id: cap.id, patch: { words: retimeWords(t, cap.start, Math.max(f, cap.duration)) } }], 'Edit caption');
          }}
        />
      </Section>
      <Section title="Style">
        <label className="nf nf--select" style={{ gridColumn: '1 / -1' }}>
          <span className="nf__label">Style</span>
          <select className="nf__input" aria-label="Caption style" value={cap.styleId} onChange={(e) => void dispatch([{ type: 'updateCaption', id: cap.id, patch: { styleId: e.target.value } }], 'Caption style')}>
            {CAPTION_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <NumberField label="Height" value={(cap.position?.y ?? 0.88) * 100} reset={88} decimals={0} step={1} min={5} max={95} unit="%" onCommit={(v) => void dispatch([{ type: 'updateCaption', id: cap.id, patch: { position: { x: cap.position?.x ?? 0.5, y: v / 100 } } }], 'Caption position')} />
      </Section>
    </div>
  );
}

/** Properties of the selected clip or caption. Each field commits one undoable edit through the same engine the agents use. */
export function Inspector() {
  const seq = useApp((s) => s.sequence);
  const media = useApp((s) => s.media);
  const selection = useTimeline((s) => s.selection);
  const first = seq ? [...selection].map((id) => findItem(seq, id)).find(Boolean) : undefined;
  if (!seq || !first) {
    return (
      <div className="empty empty--center">
        <MousePointerClick size={26} strokeWidth={1.25} />
        <p>Select a clip on the timeline to edit its properties.</p>
        <p className="faint">Position, scale, rotation, opacity, crop, speed, audio level, effects and keyframes live here.</p>
      </div>
    );
  }
  if (isCaption(first.item)) return <CaptionInspector cap={first.item} />;
  if (!isClip(first.item)) return null;
  const clip: Clip = first.item;
  const kind = first.track.kind;
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
          <Section title="Transform" onReset={() => void dispatch([{ type: 'setClipProps', clipId: clip.id, patch: { transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0 } }, linked: false }, ...['position.x', 'position.y', 'scale.x', 'scale.y', 'rotation'].filter((p) => clip.keyframes[p]).map((p): Op => ({ type: 'setKeyframes', clipId: clip.id, prop: p, keyframes: [] }))], 'Reset transform')}>
            <AnimatedField clip={clip} label="X" props={['position.x']} value={t.position.x} toStored={(v) => [v]} fromStored={(v) => v} onStatic={(v) => tf({ position: { x: v } }, 'Position X')} reset={0} decimals={0} step={1} unit="px" />
            <AnimatedField clip={clip} label="Y" props={['position.y']} value={t.position.y} toStored={(v) => [v]} fromStored={(v) => v} onStatic={(v) => tf({ position: { y: v } }, 'Position Y')} reset={0} decimals={0} step={1} unit="px" />
            <AnimatedField clip={clip} label="Scale" props={['scale.x', 'scale.y']} value={t.scale.x * 100} toStored={(v) => [v / 100, v / 100]} fromStored={(v) => v * 100} onStatic={(v) => tf({ scale: { x: v / 100, y: v / 100 } }, 'Scale')} reset={100} decimals={1} step={0.5} min={1} max={800} unit="%" />
            <AnimatedField clip={clip} label="Rotate" props={['rotation']} value={t.rotation} toStored={(v) => [v]} fromStored={(v) => v} onStatic={(v) => tf({ rotation: v }, 'Rotation')} reset={0} decimals={1} step={0.5} unit="°" />
          </Section>
          <Section title="Composite" onReset={() => tf({ opacity: 1 }, 'Reset opacity')}>
            <AnimatedField clip={clip} label="Opacity" props={['opacity']} value={t.opacity * 100} toStored={(v) => [v / 100]} fromStored={(v) => v * 100} onStatic={(v) => tf({ opacity: v / 100 }, 'Opacity')} reset={100} decimals={0} step={1} min={0} max={100} unit="%" />
          </Section>
          <Section title="Crop" onReset={() => tf({ crop: { left: 0, right: 0, top: 0, bottom: 0 } }, 'Reset crop')}>
            {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
              <NumberField key={side} label={side[0]!.toUpperCase() + side.slice(1)} value={t.crop[side] * 100} reset={0} decimals={1} step={0.5} min={0} max={95} unit="%" onCommit={(v) => tf({ crop: { [side]: v / 100 } }, `Crop ${side}`)} />
            ))}
          </Section>
          <EffectsSection clip={clip} />
        </>
      ) : (
        <Section title="Audio" onReset={() => set({ audio: { gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0 } }, 'Reset audio')}>
          <AnimatedField clip={clip} label="Gain" props={['audio.gainDb']} value={clip.audio.gainDb} toStored={(v) => [v]} fromStored={(v) => v} onStatic={(v) => set({ audio: { gainDb: v } }, 'Clip gain')} reset={0} decimals={1} step={0.1} min={-96} max={24} unit="dB" />
          <NumberField label="Pan" value={clip.audio.pan * 100} reset={0} decimals={0} step={1} min={-100} max={100} unit="L–R" onCommit={(v) => set({ audio: { pan: v / 100 } }, 'Pan')} />
          <NumberField label="Fade in" value={ticksToMs(clip.audio.fadeIn, tb)} reset={0} decimals={0} step={5} min={0} unit="ms" onCommit={(v) => set({ audio: { fadeIn: msToTicks(v, tb) } }, 'Fade in')} />
          <NumberField label="Fade out" value={ticksToMs(clip.audio.fadeOut, tb)} reset={0} decimals={0} step={5} min={0} unit="ms" onCommit={(v) => set({ audio: { fadeOut: msToTicks(v, tb) } }, 'Fade out')} />
        </Section>
      )}

      <Section title="Speed" onReset={clip.speed.num === clip.speed.den ? undefined : () => void dispatch([{ type: 'setSpeed', clipId: clip.id, speed: { num: 1, den: 1 }, linked: true, ripple: false }], 'Reset speed')}>
        <NumberField label="Speed" value={speed} reset={100} decimals={0} step={1} min={10} max={1000} unit="%" onCommit={(v) => void dispatch([{ type: 'setSpeed', clipId: clip.id, speed: speedRatio(v), linked: true, ripple: false }], 'Change speed')} />
      </Section>
      <p className="insp__note faint">Every change is one undo step. The diamond keyframes a value at the playhead.</p>
    </div>
  );
}

function EffectsSection({ clip }: { clip: Clip }) {
  return (
    <section className="insp__sec">
      <header className="insp__head">
        <h3>Effects</h3>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="btn btn--ghost btn--sm" aria-label="Add effect"><Plus size={12} /> Add</button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
              {EFFECTS.map((e) => (
                <DropdownMenu.Item key={e.type} className="menu__item" onSelect={() => void dispatch([{ type: 'applyEffect', clipId: clip.id, effect: { type: e.type, params: defaultParams(e.type), enabled: true } }], `Apply ${e.label}`)}>{e.label}</DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>
      {clip.effects.length ? clip.effects.map((fx) => <EffectCard key={fx.id} clip={clip} fx={fx} />) : <p className="faint insp__none">No effects. Add one here or from the Effects tab.</p>}
    </section>
  );
}
