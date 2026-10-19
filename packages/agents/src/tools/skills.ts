import { z } from 'zod';
import { type ToolDef, defineTool } from './read';
import { ToolError } from '../types';

export const skillTools: ToolDef[] = [
  defineTool({
    name: 'list_skills',
    description: 'The skills available: ready-made, step-by-step workflows (for example a YouTube retention cut). Returns name and description of each.',
    schema: z.object({}),
    scope: 'read',
    run: (ctx) => (ctx.host.skills?.() ?? []).map((s) => ({ name: s.name, description: s.description })),
  }),
  defineTool({
    name: 'use_skill',
    description: 'Load a skill\'s full instructions and follow them. Use when the request matches a skill\'s description (see list_skills), or when the user names one.',
    schema: z.object({ name: z.string() }),
    scope: 'read',
    run: (ctx, a) => {
      const skills = ctx.host.skills?.() ?? [];
      const s = skills.find((x) => x.name === a.name.replace(/^\//, ''));
      if (!s) throw new ToolError(`No skill "${a.name}". Available: ${skills.map((x) => x.name).join(', ') || 'none'}.`);
      return { name: s.name, instructions: s.body };
    },
  }),
];
