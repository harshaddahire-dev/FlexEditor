import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Brain, Check, ChevronRight, CircleDashed, Eye, EyeOff, Hand, Loader2, Send, Square, Undo2, X } from 'lucide-react';
import { type ChatTurn, diffSummary } from '@cutroom/core';
import { ROLE_LABEL, type Step, arrange, stepsOf, toolLabel } from '../lib/agentView';
import { useAgent } from '../store/agent';
import { useTimeline } from '../store/timeline';
import { ICON } from './ui';

const SUGGESTIONS = [
  'Put everything on the timeline in a sensible order',
  'Remove the silences and filler words',
  'Make a 30-second highlight',
  'Balance the audio to about −16 LUFS',
];

/** Minimal inline formatting for model text: **bold**, `code`, and paragraphs. */
function Prose({ text }: { text: string }) {
  const paras = text.split(/\n{2,}/).filter((p) => p.trim());
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part,
    );
  return (
    <>
      {paras.map((p, i) => (
        <p key={i}>{inline(p.trim())}</p>
      ))}
    </>
  );
}

function ToolCard({ step, turn }: { step: Extract<Step, { kind: 'tool' }>; turn: ChatTurn }) {
  const [open, setOpen] = useState(false);
  const decide = useAgent((s) => s.decide);
  const running = !step.result && !step.awaiting && turn.status === 'running';
  const state = step.awaiting ? 'wait' : step.result ? (step.result.ok ? 'ok' : 'bad') : running ? 'run' : 'idle';
  const specialist = step.role !== 'director';
  return (
    <div className="tcard" data-state={state} data-scope={step.scope}>
      <button className="tcard__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tcard__icon">
          {state === 'run' ? <Loader2 size={13} className="spin" /> : state === 'ok' ? <Check size={13} /> : state === 'bad' ? <X size={13} /> : state === 'wait' ? <Hand size={13} /> : <CircleDashed size={13} />}
        </span>
        <span className="tcard__title">{step.result?.ok && step.scope === 'edit' ? step.result.summary : toolLabel(step.tool)}</span>
        {specialist ? <span className="tcard__role">{ROLE_LABEL[step.role]}</span> : null}
        <ChevronRight size={12} className="tcard__chev" data-open={open} />
      </button>
      {step.result && !step.result.ok ? <div className="tcard__err">{step.result.summary}</div> : null}
      {step.awaiting && turn.pending ? (
        <div className="tcard__ask" role="group" aria-label="Approve this edit">
          <span>Allow this edit?</span>
          <button className="btn btn--primary btn--sm" onClick={() => void decide(turn.runId, turn.pending!.id, 'approve')}>Approve</button>
          <button className="btn btn--sm" onClick={() => void decide(turn.runId, turn.pending!.id, 'deny')}>Deny</button>
          <button className="btn btn--ghost btn--sm" onClick={() => void decide(turn.runId, turn.pending!.id, 'always')}>Approve all this run</button>
        </div>
      ) : null}
      {open ? (
        <pre className="tcard__body">
          {JSON.stringify(step.args, null, 2)}
          {step.result?.data !== undefined ? `\n→ ${JSON.stringify(step.result.data, null, 2)}` : ''}
        </pre>
      ) : null}
    </div>
  );
}

function StepsView({ turn }: { turn: ChatTurn }) {
  const items = arrange(stepsOf(turn.events, turn.pending?.id));
  return (
    <>
      {items.map((it, i) => {
        if (it.kind === 'text') return <div key={i} className="msg__text"><Prose text={it.text} /></div>;
        if (it.kind === 'thinking') return <Thinking key={i} text={it.text} live={turn.status === 'running' && i === items.length - 1} />;
        if (it.kind === 'tool') return <ToolCard key={it.id} step={it} turn={turn} />;
        if (it.kind === 'reads') return <ReadGroup key={i} steps={it.steps} turn={turn} />;
        if (it.kind === 'qa') return <div key={i} className="msg__qa" role="status"><AlertTriangle size={13} /> Checking the result: {it.issues.length} possible problem{it.issues.length === 1 ? '' : 's'} found — fixing.</div>;
        return <div key={i} className="msg__error" role="alert"><AlertTriangle size={13} /> {it.message}</div>;
      })}
    </>
  );
}

function ReadGroup({ steps, turn }: { steps: Extract<Step, { kind: 'tool' }>[]; turn: ChatTurn }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 1) return <ToolCard step={steps[0]!} turn={turn} />;
  const failed = steps.filter((s) => s.result && !s.result.ok).length;
  return (
    <div className="tgroup">
      <button className="tgroup__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={12} data-open={open} className="tcard__chev" />
        Looked around · {steps.length} reads{failed ? ` (${failed} failed)` : ''}
      </button>
      {open ? steps.map((s) => <ToolCard key={s.id} step={s} turn={turn} />) : null}
    </div>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="think">
      <button className="think__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {live ? <Loader2 size={12} className="spin" /> : <Brain size={12} />} {live ? 'Thinking…' : 'Thought'}
      </button>
      {open ? <p className="think__body">{text}</p> : null}
    </div>
  );
}

/** What the run changed, with the review actions. The timeline overlay shows the same changes while this is open. */
function ReviewBar({ turn }: { turn: ChatTurn }) {
  const { review, showGhosts, toggleGhosts } = useAgent();
  const [err, setErr] = useState<string | null>(null);
  if (!turn.diff || turn.status === 'running') return null;
  const act = async (a: 'accept' | 'undo' | 'dismiss') => setErr(await review(turn.runId, a));
  const d = turn.diff;
  return (
    <div className="review" data-review={turn.review}>
      <div className="review__sum">
        <span className="review__chips">
          {d.added.length ? <span className="rchip rchip--add">+{d.added.length}</span> : null}
          {d.removed.length ? <span className="rchip rchip--del">−{d.removed.length}</span> : null}
          {d.changed.length ? <span className="rchip rchip--chg">~{d.changed.length}</span> : null}
        </span>
        <span>{diffSummary(d)}</span>
        {turn.review === 'accepted' ? <span className="review__state">Accepted</span> : turn.review === 'undone' ? <span className="review__state">Undone</span> : turn.review === 'dismissed' ? <span className="review__state">Reviewed</span> : null}
      </div>
      {turn.review === 'pending' ? (
        <div className="review__actions">
          <button className="btn btn--primary btn--sm" onClick={() => void act('accept')}><Check size={13} />Keep</button>
          <button className="btn btn--sm" onClick={() => void act('undo')}><Undo2 size={13} />Undo all</button>
          <button className="btn btn--ghost btn--sm" aria-pressed={showGhosts} onClick={toggleGhosts} title="Show removed and moved items on the timeline">
            {showGhosts ? <Eye size={13} /> : <EyeOff size={13} />}Changes
          </button>
        </div>
      ) : null}
      {err ? <div className="msg__error" role="alert">{err}</div> : null}
    </div>
  );
}

function TurnView({ turn }: { turn: ChatTurn }) {
  return (
    <article className="turn" data-status={turn.status}>
      <div className="msg msg--user">{turn.prompt}</div>
      <div className="msg msg--agent">
        <StepsView turn={turn} />
        {turn.status === 'running' && !turn.events.some((e) => e.type === 'text' || e.type === 'tool_call') ? <span className="faint row"><Loader2 size={13} className="spin" /> Working…</span> : null}
        {turn.status === 'cancelled' ? <div className="msg__note">Stopped.</div> : null}
        {turn.status === 'error' && !turn.events.some((e) => e.type === 'error') ? <div className="msg__error" role="alert"><AlertTriangle size={13} /> {turn.summary}</div> : null}
        <ReviewBar turn={turn} />
      </div>
    </article>
  );
}

export function AgentThread() {
  const { turns, loaded, providers } = useAgent();
  const ref = useRef<HTMLDivElement>(null);
  const tail = turns[turns.length - 1];
  const sig = `${turns.length}:${tail?.events.length ?? 0}:${tail?.status}:${tail?.pending?.id ?? ''}`;
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sig]);
  void providers;
  if (!loaded) return <div className="agent__thread" />;
  return (
    <div className="agent__thread agent__thread--chat" ref={ref} role="log" aria-label="Conversation" aria-live="polite">
      {turns.map((t) => (
        <TurnView key={t.runId} turn={t} />
      ))}
    </div>
  );
}

export function Composer() {
  const { settings, providers, activeRunId, send, stop, sendError, turns } = useAgent();
  const [text, setText] = useState('');
  const ready = !!settings.providerId && !!settings.model && providers.length > 0;
  const busy = !!activeRunId;
  const hasClips = useTimeline((s) => s.selection.size);
  void hasClips;
  const submit = async () => {
    const p = text.trim();
    if (!p || busy || !ready) return;
    if (await send(p)) setText('');
  };
  return (
    <div className="composer-wrap">
      {!turns.length && ready ? (
        <div className="suggest" aria-label="Suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="suggest__chip" onClick={() => setText(s)}>{s}</button>
          ))}
        </div>
      ) : null}
      {sendError ? <div className="msg__error composer__error" role="alert">{sendError}</div> : null}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          className="composer__input"
          rows={2}
          placeholder={ready ? 'Describe the edit…' : 'Connect a provider and choose a model to start'}
          disabled={!ready}
          aria-label="Message the agent"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {busy ? (
          <button className="btn btn--icon" type="button" aria-label="Stop" onClick={() => void stop()}><Square size={13} fill="currentColor" /></button>
        ) : (
          <button className="btn btn--primary btn--icon" type="submit" disabled={!ready || !text.trim()} aria-label="Send"><Send {...ICON} size={14} /></button>
        )}
      </form>
    </div>
  );
}
