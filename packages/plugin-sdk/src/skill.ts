/** A skill is a folder with a SKILL.md: YAML-ish frontmatter (name, description) and instructions for the agents. */
export interface Skill {
  name: string;
  description: string;
  /** The instructions the agent follows once it picks the skill. */
  body: string;
  /** Where it came from: 'builtin' | 'project' | 'user' | `plugin:<id>`. */
  source: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Parse a SKILL.md. Throws a readable Error when the file is not a valid skill. */
export function parseSkill(text: string, source: string, fallbackName?: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!m) throw new Error('SKILL.md must start with a --- frontmatter block containing name and description.');
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]!.toLowerCase()] = v;
  }
  const name = meta.name ?? fallbackName;
  if (!name || !NAME.test(name)) throw new Error(`Skill name "${name ?? ''}" must be lowercase letters, digits and dashes.`);
  if (!meta.description) throw new Error(`Skill "${name}" needs a description (one line the agent uses to decide when to use it).`);
  const body = m[2]!.trim();
  if (!body) throw new Error(`Skill "${name}" has no instructions.`);
  return { name, description: meta.description, body, source };
}
