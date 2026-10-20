import fs from 'node:fs/promises';
import path from 'node:path';
import { type Skill, parseSkill } from '@cutroom/plugin-sdk';

/** Read `<dir>/<name>/SKILL.md` for every sub-folder. Broken skills are reported, not fatal. */
export async function loadSkillsFrom(dir: string, source: string): Promise<{ skills: Skill[]; errors: string[] }> {
  const skills: Skill[] = [];
  const errors: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { skills, errors };
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      skills.push(parseSkill(text, source, e.name));
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }
  return { skills, errors };
}
