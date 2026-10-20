import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Play, Puzzle, Sparkles } from 'lucide-react';
import type { SkillInfo } from '@cutroom/core';
import { useAgent } from '../store/agent';
import { useExtensions } from '../store/extensions';
import { useUi } from '../store/ui';
import { ICON } from './ui';

const sourceLabel = (s: string) => (s === 'builtin' ? 'Built-in' : s === 'user' ? 'Yours' : s === 'project' ? 'Project' : s.startsWith('plugin:') ? `Plugin · ${s.slice(7)}` : s);

function SkillRow({ skill }: { skill: SkillInfo }) {
  const [open, setOpen] = useState(false);
  const { setSkill } = useExtensions();
  const send = useAgent((s) => s.send);
  const ready = useAgent((s) => !!s.settings.providerId && !!s.settings.model && s.providers.length > 0 && !s.activeRunId);
  const setRightTab = useUi((s) => s.setRightTab);
  return (
    <li className="skill" data-off={!skill.enabled} data-testid={`skill-${skill.name}`}>
      <div className="skill__head">
        <button className="skill__toggle" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} steps of ${skill.name}`} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown {...ICON} size={13} /> : <ChevronRight {...ICON} size={13} />}
        </button>
        <div className="skill__main">
          <strong className="mono skill__name">/{skill.name}</strong>
          <span className="skill__desc">{skill.description}</span>
          <div className="skill__meta">
            <span className="skill__src">{sourceLabel(skill.source)}</span>
            <button
              className="btn btn--sm skill__run"
              disabled={!skill.enabled || !ready}
              title={ready ? 'Ask the agent to run this skill' : 'Connect a provider and choose a model first'}
              onClick={async () => {
                setRightTab('agent');
                await send(`/${skill.name}`);
              }}
            >
              <Play {...ICON} size={11} />Run
            </button>
          </div>
        </div>
        <label className="switch" title={skill.enabled ? 'Enabled' : 'Disabled'}>
          <input type="checkbox" role="switch" aria-label={`Enable ${skill.name}`} checked={skill.enabled} onChange={(e) => void setSkill(skill.name, e.target.checked)} />
          <span className="switch__track" />
        </label>
      </div>
      {open ? <pre className="skill__body">{skill.body}</pre> : null}
    </li>
  );
}

/** Skills: step-by-step recipes the Director follows. Run one directly, or type /name in the Agent tab. */
export function SkillsPanel() {
  const { info, load, error } = useExtensions();
  const openSettings = useUi((s) => s.openSettings);
  useEffect(() => void load(), [load]);
  const skills = info?.skills ?? [];
  return (
    <div className="skills">
      <p className="muted skills__intro">
        <Sparkles {...ICON} size={12} className="skills__icon" />Skills are recipes the agent follows. Run one here, or type <span className="mono">/name</span> in the Agent tab.
      </p>
      {error ? <div className="callout" role="alert">{error}</div> : null}
      {info?.errors.length ? <div className="callout callout--warn">{info.errors.map((e) => <div key={e}>{e}</div>)}</div> : null}
      <ul className="skill-list" aria-label="Skills">
        {skills.map((s) => <SkillRow key={s.name} skill={s} />)}
      </ul>
      {info && !skills.length ? <div className="empty"><p>No skills found.</p></div> : null}
      <div className="skills__foot">
        <p className="faint">Add your own as <span className="mono">&lt;name&gt;/SKILL.md</span> in <span className="mono skills__dir">{info?.dirs.skills[1] ?? 'the data folder'}</span> (or the project's <span className="mono">.cutroom/skills</span>).</p>
        <button className="btn btn--sm" onClick={() => openSettings('extensions')}><Puzzle {...ICON} size={12} />Plugins &amp; MCP</button>
      </div>
    </div>
  );
}
