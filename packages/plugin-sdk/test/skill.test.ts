import { describe, expect, it } from 'vitest';
import { parseSkill, toolName } from '../src';

describe('parseSkill', () => {
  it('reads frontmatter and body', () => {
    const s = parseSkill('---\nname: my-skill\ndescription: "Does a thing: well"\n---\n# Title\n\nSteps.\n', 'user');
    expect(s).toEqual({ name: 'my-skill', description: 'Does a thing: well', body: '# Title\n\nSteps.', source: 'user' });
  });
  it('accepts CRLF, a BOM, single quotes and falls back to the folder name', () => {
    const s = parseSkill('﻿---\r\ndescription: \'Hi\'\r\n---\r\nBody', 'builtin', 'folder-name');
    expect(s).toMatchObject({ name: 'folder-name', description: 'Hi', body: 'Body' });
  });
  it('rejects what an agent could not use, with a reason', () => {
    expect(() => parseSkill('no frontmatter', 'x')).toThrow(/frontmatter/);
    expect(() => parseSkill('---\nname: Bad Name\ndescription: d\n---\nbody', 'x')).toThrow(/lowercase/);
    expect(() => parseSkill('---\nname: ok\n---\nbody', 'x')).toThrow(/description/);
    expect(() => parseSkill('---\nname: ok\ndescription: d\n---\n   ', 'x')).toThrow(/no instructions/);
  });
});

describe('toolName', () => {
  it('stays provider-safe and bounded', () => {
    expect(toolName('mcp_my server', 'do.thing')).toBe('mcp_my_server__do_thing');
    expect(toolName('p', 'x'.repeat(100))).toHaveLength(64);
  });
});
