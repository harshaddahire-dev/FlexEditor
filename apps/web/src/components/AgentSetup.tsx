import { useEffect, useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Bot, Check, ChevronsUpDown, RefreshCw, Settings2 } from 'lucide-react';
import { AGENT_MODES, type AgentMode, type Effort, EFFORTS, contextWindowFor } from '@cutroom/core';
import { useAgent } from '../store/agent';
import { useUi } from '../store/ui';
import { AgentThread, Composer } from './AgentChat';
import { ICON, Tip } from './ui';

const EFFORT_LABEL: Record<Effort, string> = { off: 'Off', low: 'Low', medium: 'Med', high: 'High', max: 'Max' };
const EFFORT_HINT: Record<Effort, string> = {
  off: 'No extended thinking — fastest and cheapest',
  low: 'Brief reasoning',
  medium: 'Balanced (default)',
  high: 'Careful reasoning for tricky edits',
  max: 'Maximum thinking budget — slow and costly',
};
const MODE_LABEL: Record<AgentMode, string> = { ask: 'Ask', auto: 'Auto', full: 'Full access' };
const MODE_HINT: Record<AgentMode, string> = {
  ask: 'Every edit waits for your approval.',
  auto: 'Edits apply right away; review them as a diff and undo anything.',
  full: 'Auto, plus agents may run plugins and tools that reach outside this project.',
};

export const formatTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function ModelPicker() {
  const { providers, settings, models, setSettings, loadModels } = useAgent();
  const openSettings = useUi((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const provider = providers.find((p) => p.id === settings.providerId);
  const entry = provider ? models[provider.id] : undefined;

  useEffect(() => {
    if (open && provider) void loadModels(provider.id);
  }, [open, provider, loadModels]);

  const list = entry?.models ?? [];
  const exact = list.some((m) => m.id === query.trim());

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="picker" aria-haspopup="listbox">
          <Bot {...ICON} />
          <span className="sr-only">Model: </span>
          <span className="picker__text">
            <span className="picker__model">{provider ? settings.model ?? 'Choose a model' : 'Choose a model'}</span>
            <span className="picker__prov faint">{provider ? provider.name : 'No provider connected'}</span>
          </span>
          <ChevronsUpDown size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" align="start" sideOffset={6} collisionPadding={12}>
          {providers.length > 1 ? (
            <div className="popover__provs" role="radiogroup" aria-label="Provider">
              {providers.map((p) => (
                <button key={p.id} role="radio" aria-checked={p.id === settings.providerId} className="pform__kind" data-on={p.id === settings.providerId} onClick={() => void setSettings({ providerId: p.id, model: p.defaultModel })}>
                  {p.name}
                </button>
              ))}
            </div>
          ) : null}
          {provider ? (
            <Command className="cmd" shouldFilter label="Models">
              <div className="cmd__bar">
                <Command.Input className="cmd__input" placeholder="Search or type a model id…" value={query} onValueChange={setQuery} />
                <Tip label="Refresh the model list">
                  <button className="btn btn--ghost btn--icon btn--xs" aria-label="Refresh models" onClick={() => void loadModels(provider.id, true)}><RefreshCw size={12} className={entry?.loading ? 'spin' : ''} /></button>
                </Tip>
              </div>
              <Command.List className="cmd__list">
                {entry?.loading && !list.length ? <div className="cmd__empty faint">Loading models…</div> : null}
                {entry?.error ? <div className="cmd__empty cmd__error" role="alert">{entry.error}</div> : null}
                <Command.Empty className="cmd__empty faint">No matching model.</Command.Empty>
                {list.map((m) => (
                  <Command.Item
                    key={m.id}
                    value={m.id}
                    className="cmd__item"
                    onSelect={() => {
                      void setSettings({ model: m.id });
                      setOpen(false);
                    }}
                  >
                    <span className="cmd__check">{settings.model === m.id ? <Check size={13} /> : null}</span>
                    <span className="cmd__name">{m.id}</span>
                    {m.contextWindow ? <span className="faint mono">{formatTokens(m.contextWindow)}</span> : null}
                  </Command.Item>
                ))}
                {query.trim() && !exact ? (
                  <Command.Item
                    value={`__custom ${query}`}
                    className="cmd__item"
                    onSelect={() => {
                      void setSettings({ model: query.trim() });
                      setOpen(false);
                    }}
                  >
                    <span className="cmd__check" />
                    <span className="cmd__name">Use “{query.trim()}”</span>
                  </Command.Item>
                ) : null}
              </Command.List>
            </Command>
          ) : (
            <div className="popover__empty">
              <p>No provider is connected yet.</p>
              <button className="btn btn--primary btn--sm" onClick={() => (setOpen(false), openSettings('providers'))}>Add a provider</button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ContextMeter() {
  const { settings, models, providers, contextUsed, loadModels } = useAgent();
  const provider = providers.find((p) => p.id === settings.providerId);
  // the context window comes from the provider's model list; fetch it once so the meter can show a limit
  useEffect(() => {
    if (provider && settings.model) void loadModels(provider.id);
  }, [provider, settings.model, loadModels]);
  const known = provider && settings.model ? models[provider.id]?.models.find((m) => m.id === settings.model)?.contextWindow : null;
  const window = known ?? (settings.model ? contextWindowFor(settings.model) : null);
  const ratio = window ? Math.min(1, contextUsed / window) : 0;
  return (
    <Tip label={window ? `${contextUsed.toLocaleString()} of ${window.toLocaleString()} tokens in this conversation` : 'Context size unknown for this model'}>
      <div className="ctx" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={window ?? 0} aria-valuenow={contextUsed}>
        <div className="ctx__bar"><i style={{ width: `${ratio * 100}%` }} data-level={ratio > 0.9 ? 'high' : ratio > 0.75 ? 'warn' : 'ok'} /></div>
        <span className="ctx__text mono">{formatTokens(contextUsed)} / {window ? formatTokens(window) : '—'}</span>
      </div>
    </Tip>
  );
}

/** Model, effort and mode: the controls that sit under the message box. */
function Controls() {
  const { settings, setSettings } = useAgent();
  return (
    <>
      <div className="composer__row">
        <ModelPicker />
        <span className="spacer" />
        <ContextMeter />
      </div>
      <div className="composer__row composer__row--tune">
        <div className="seg seg--flat" role="radiogroup" aria-label="Reasoning effort">
          {EFFORTS.map((e) => (
            <Tip key={e} label={`Effort: ${EFFORT_HINT[e]}`}>
              <button type="button" role="radio" aria-checked={settings.effort === e} className="seg__btn" data-state={settings.effort === e ? 'on' : 'off'} onClick={() => void setSettings({ effort: e })}>
                {EFFORT_LABEL[e]}
              </button>
            </Tip>
          ))}
        </div>
        <span className="spacer" />
        <div className="seg seg--flat" role="radiogroup" aria-label="Agent mode">
          {AGENT_MODES.map((m) => (
            <Tip key={m} label={`${MODE_LABEL[m]}: ${MODE_HINT[m]}`}>
              <button type="button" role="radio" aria-label={MODE_LABEL[m]} aria-checked={settings.mode === m} className="seg__btn" data-state={settings.mode === m ? 'on' : 'off'} onClick={() => void setSettings({ mode: m })}>
                {m === 'full' ? 'Full' : MODE_LABEL[m]}
              </button>
            </Tip>
          ))}
        </div>
      </div>
    </>
  );
}

/** The agent column: conversation on top, message box with its controls at the bottom. */
export function AgentSetup() {
  const { settings, providers, loaded, turns } = useAgent();
  const openSettings = useUi((s) => s.openSettings);
  const noProvider = loaded && providers.length === 0;
  const ready = useMemo(() => !!settings.providerId && !!settings.model, [settings]);

  return (
    <div className="agent">
      {noProvider ? (
        <div className="agent__thread">
          <div className="empty empty--center">
            <Settings2 size={26} strokeWidth={1.25} />
            <p>Connect a model provider to start.</p>
            <p className="faint">OpenRouter, OpenAI, Anthropic, Gemini or any OpenAI-compatible server. Keys stay on this machine, encrypted.</p>
            <button className="btn btn--primary" onClick={() => openSettings('providers')}>Add a provider</button>
          </div>
        </div>
      ) : turns.length ? (
        <AgentThread />
      ) : (
        <div className="agent__thread">
          <div className="empty empty--center">
            <Bot size={28} strokeWidth={1.25} />
            <p>{ready ? 'What should we cut?' : 'Pick a model below.'}</p>
            <p className="faint">The Director plans the edit and hands focused jobs to a Cutter, Audio and other specialists. You see every step and can undo the whole run.</p>
          </div>
        </div>
      )}

      <Composer controls={<Controls />} />
    </div>
  );
}
