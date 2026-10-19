import { describe, expect, it } from 'vitest';
import { type ExternalTool, type Skill, pluginTools } from '@cutroom/plugin-sdk';
import { z } from 'zod';
import { type RunOptions, expandSkillCommand, runAgent, toolSpecsFor } from '../src';
import { collect, makeHost, scripted } from './helpers';

const base = (emit: RunOptions['emit'], over: Partial<RunOptions> = {}): RunOptions => ({ runId: 'r8', prompt: 'go', mode: 'auto', effort: 'off', model: 'm', emit, approve: async () => true, ...over });
const results = (llm: ReturnType<typeof scripted>) => llm.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));

const SKILLS: Skill[] = [
  { name: 'tighten', description: 'Tighten talking heads', body: '1. get_silences\n2. remove them', source: 'builtin' },
  { name: 'chapters', description: 'Add chapter markers', body: 'Add markers.', source: 'builtin' },
];

const echo: ExternalTool = { name: 'mcp_x__echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } }, scope: 'read', source: 'mcp:x', call: async (a) => ({ echoed: a.text }) };

describe('skills', () => {
  it('lists skills in the Director prompt and loads one on request', async () => {
    const llm = scripted([() => ({ calls: [{ name: 'list_skills', args: {} }, { name: 'use_skill', args: { name: 'tighten' } }, { name: 'use_skill', args: { name: 'nope' } }] }), () => ({ text: 'ok' })]);
    const host = { ...makeHost(llm), skills: () => SKILLS };
    await runAgent(host, base(collect().emit));
    expect(llm.requests[0]!.messages[0]!.content).toContain('- tighten: Tighten talking heads');
    expect(llm.requests[0]!.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(['list_skills', 'use_skill']));
    const [list, use, missing] = results(llm);
    expect(list).toHaveLength(2);
    expect(use).toEqual({ name: 'tighten', instructions: '1. get_silences\n2. remove them' });
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/No skill "nope"\. Available: tighten, chapters/) });
  });

  it('turns /skill-name into an instruction but keeps unknown slashes as typed', () => {
    expect(expandSkillCommand('/tighten make it fast', SKILLS)).toMatch(/Use the "tighten" skill[\s\S]*The user adds: make it fast/);
    expect(expandSkillCommand('/chapters', SKILLS)).not.toMatch(/user adds/);
    expect(expandSkillCommand('/unknown thing', SKILLS)).toBe('/unknown thing');
    expect(expandSkillCommand('please /tighten', SKILLS)).toBe('please /tighten');
  });

  it('sends the expanded command to the model but shows the user\'s own words', async () => {
    const llm = scripted([() => ({ text: 'ok' })]);
    const host = { ...makeHost(llm), skills: () => SKILLS };
    const c = collect();
    await runAgent(host, base(c.emit, { prompt: '/tighten please' }));
    expect(llm.requests[0]!.messages.at(-1)!.content).toMatch(/Use the "tighten" skill/);
    expect(c.events.find((e) => e.type === 'run_start')).toMatchObject({ prompt: '/tighten please' });
  });
});

describe('external tools (plugins and MCP)', () => {
  const run = async (mode: 'ask' | 'auto' | 'full', tool = echo) => {
    const llm = scripted([() => ({ calls: [{ name: tool.name, args: { text: 'hi' } }] }), () => ({ text: 'done' })]);
    const host = { ...makeHost(llm), externalTools: () => [tool] };
    const c = collect();
    await runAgent(host, base(c.emit, { mode }));
    return { llm, c, host };
  };

  it('are offered and run in Full access', async () => {
    const { llm, c } = await run('full');
    expect(llm.requests[0]!.tools!.map((t) => t.name)).toContain('mcp_x__echo');
    expect(llm.requests[0]!.messages[0]!.content).toMatch(/Extra tools from plugins\/MCP servers.*mcp_x__echo/);
    expect(results(llm)[0]).toEqual({ echoed: 'hi' });
    expect(c.events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, summary: 'mcp:x: mcp_x__echo' });
  });

  it('are neither offered nor callable in Ask and Auto modes', async () => {
    for (const mode of ['ask', 'auto'] as const) {
      const { llm } = await run(mode);
      expect(llm.requests[0]!.tools!.map((t) => t.name)).not.toContain('mcp_x__echo');
      expect(results(llm)[0]).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown tool "mcp_x__echo"/) });
    }
  });

  it('are never given to specialists', () => {
    expect(toolSpecsFor('cutter', [echo]).map((t) => t.name)).not.toContain('mcp_x__echo');
    expect(toolSpecsFor('director', [echo]).map((t) => t.name)).toContain('mcp_x__echo');
  });

  it('report failures to the model instead of crashing the run', async () => {
    const bad: ExternalTool = { ...echo, call: async () => { throw new Error('server went away'); } };
    const { llm, c } = await run('full', bad);
    expect(results(llm)[0]).toMatchObject({ ok: false, error: 'server went away' });
    expect(c.events.at(-1)).toMatchObject({ type: 'done', cancelled: false });
  });

  it('plugin tools can edit through the engine, in the run\'s undo group, and get schema-checked arguments', async () => {
    const [tool] = pluginTools({
      id: 'demo',
      name: 'Demo',
      version: '1',
      tools: [{ name: 'mark', description: 'Drop a marker', scope: 'edit', schema: z.object({ label: z.string() }), run: (ctx, a) => ctx.applyOps([{ type: 'addMarker', time: 0, label: (a as { label: string }).label } as never], { label: 'Plugin marker' }) }],
    });
    expect(tool!.name).toBe('plugin_demo__mark');
    expect(tool!.parameters).toMatchObject({ type: 'object', properties: { label: { type: 'string' } }, required: ['label'] });
    const llm = scripted([() => ({ calls: [{ name: tool!.name, args: { label: 'From plugin' } }, { name: tool!.name, args: {} }] }), () => ({ text: 'done' })]);
    const host = { ...makeHost(llm), externalTools: () => [tool!] };
    const r = await runAgent(host, base(collect().emit, { mode: 'full' }));
    expect(r.edits).toBe(1);
    expect(host.calls[0]).toMatchObject({ label: 'Plugin marker', group: 'run_r8', origin: 'agent:director' });
    expect(host.sequence().markers.map((m) => m.label)).toEqual(['From plugin']);
    expect(results(llm)[1]).toMatchObject({ ok: false, error: expect.stringMatching(/Invalid arguments: label/) });
  });
});
