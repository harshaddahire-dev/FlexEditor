import { z } from 'zod';
import { type ChatMessage, type ToolCall, type ToolSpec, estimateTokens } from '@cutroom/core';
import { baseline, qaCheck } from './qa';
import { PREAMBLE, ROLES, SPECIALISTS } from './roles';
import { editTools } from './tools/edit';
import { type ToolDef, defineTool, readTools } from './tools/read';
import { skillTools } from './tools/skills';
import type { ExternalTool, PluginContext, Skill } from '@cutroom/plugin-sdk';
import { type AgentHost, HostEditError, type Role, type RunOptions, type RunResult, ToolError } from './types';

const MAX_RESULT_CHARS = 12_000;
const QA_ROUNDS = 2;

const TOOLS = new Map<string, ToolDef>([...readTools, ...editTools, ...skillTools].map((t) => [t.name, t]));

/** JSON Schema of a tool's arguments, as the providers expect it. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const j = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete j.$schema;
  return j;
}

const delegateTool = defineTool({
  name: 'delegate',
  description: `Hand a focused job to a specialist and get their report back. Roles: ${SPECIALISTS.map((r) => `${r} (${ROLES[r].summary})`).join(' · ')}. Give a complete, self-contained task: ids, times, what "done" looks like.`,
  schema: z.object({ role: z.enum(SPECIALISTS as [Role, ...Role[]]), task: z.string().min(10) }),
  scope: 'edit', // specialists edit, so delegating follows the same approval rules as the edits they will make
  run: () => {
    throw new Error('handled by the runtime');
  },
});

export function toolSpecsFor(role: Role, external: ExternalTool[] = []): ToolSpec[] {
  const names = ROLES[role].tools;
  const own = names.map((n) => (n === 'delegate' ? delegateTool : TOOLS.get(n))).filter((t): t is ToolDef => !!t).map((t) => ({ name: t.name, description: t.description, parameters: jsonSchemaOf(t.schema) }));
  return role === 'director' ? [...own, ...external.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))] : own;
}

/** `/skill-name rest of the request` → an instruction that makes the Director load that skill. */
export function expandSkillCommand(prompt: string, skills: Skill[]): string {
  const m = /^\/([a-z0-9][a-z0-9-]*)\b\s*([\s\S]*)$/.exec(prompt.trim());
  const skill = m && skills.find((s) => s.name === m[1]);
  if (!m || !skill) return prompt;
  return `Use the "${skill.name}" skill (call use_skill, then follow its steps).${m[2] ? `\nThe user adds: ${m[2]}` : ''}`;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One line describing what an edit call will do, for approval cards and the transcript. */
export function summarizeCall(tool: string, args: Record<string, unknown>): string {
  const a = args as Record<string, any>;
  switch (tool) {
    case 'add_clip': return `Add ${a.mediaId} at ${a.at}${a.mode === 'overwrite' ? ' (overwrite)' : ''}`;
    case 'split': return `Split ${a.clipId} at ${a.at}`;
    case 'trim': return `${a.ripple ? 'Ripple-trim' : 'Trim'} ${a.edge} of ${a.clipId} to ${a.to}`;
    case 'delete_clips': return `${a.ripple ? 'Ripple-delete' : 'Delete'} ${(a.clipIds ?? []).join(', ')}`;
    case 'remove_range': return `Remove ${a.from} → ${a.to}${a.ripple === false ? '' : ' and close the gap'}`;
    case 'move_clips': return `Move ${(a.clipIds ?? []).join(', ')} ${a.to !== undefined ? `to ${a.to}` : `by ${a.delta}s`}`;
    case 'set_speed': return `Set ${a.clipId} to ${a.speed}× speed`;
    case 'delegate': return `Ask the ${a.role}: ${clip(String(a.task ?? ''), 140)}`;
    default: return clip(`${tool} ${JSON.stringify(args)}`, 160);
  }
}

function contextLine(host: AgentHost, role: Role = 'director', external: ExternalTool[] = []): string {
  const seq = host.sequence();
  const fps = seq.timebase.fps.num / seq.timebase.fps.den;
  let out = `Project: sequence "${seq.name}", ${seq.width}x${seq.height} at ${Math.round(fps * 1000) / 1000} fps, ${host.media().length} media file(s).`;
  const skills = host.skills?.() ?? [];
  if (role === 'director' && skills.length) out += `\nSkills (load with use_skill):\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`;
  if (role === 'director' && external.length) out += `\nExtra tools from plugins/MCP servers (Full access): ${external.map((t) => t.name).join(', ')}. They run outside Cutroom; use them only when the request needs them.`;
  return out;
}

class Aborted extends Error {}

/**
 * Run one request end to end: the Director thinks, calls tools (and delegates to specialists), edits are grouped under
 * one id so the whole run can be undone at once, and an automatic QA pass feeds new problems back for a fix.
 */
export async function runAgent(host: AgentHost, o: RunOptions): Promise<RunResult> {
  const group = `run_${o.runId}`;
  const state = { edits: 0, firstRev: null as number | null, lastRev: null as number | null, approveAll: o.mode !== 'ask', ids: 0 };
  const before = baseline(host);
  // plugins and MCP servers run code outside Cutroom, so they are offered only when the user chose Full access
  const external = o.mode === 'full' ? (host.externalTools?.() ?? []) : [];
  const externalByName = new Map(external.map((t) => [t.name, t]));
  o.emit({ type: 'run_start', runId: o.runId, role: 'director', prompt: o.prompt });

  const ctx = (role: Role) => ({
    host,
    role,
    group,
    onEdit: (rev: number) => {
      state.edits++;
      state.firstRev ??= rev;
      state.lastRev = rev;
    },
  });

  async function executeExternal(role: Role, call: ToolCall, ext: ExternalTool, id: string): Promise<{ content: string; ok: boolean }> {
    o.emit({ type: 'tool_call', id, role, tool: ext.name, args: call.arguments, scope: ext.scope });
    const c = ctx(role);
    const pctx: PluginContext = {
      sequence: () => host.sequence(),
      media: () => host.media(),
      analysis: (m, k) => host.analysis(m, k),
      applyOps: (ops, opts) => {
        const r = host.applyOps(ops, { label: opts.label, origin: `agent:${role}`, group });
        c.onEdit(r.revision);
        return r;
      },
      log: (m) => host.log?.(`[${ext.source}] ${m}`),
      signal: o.signal,
    };
    try {
      const data = await ext.call((call.arguments ?? {}) as Record<string, unknown>, pctx);
      const text = JSON.stringify(data ?? null);
      o.emit({ type: 'tool_result', id, role, tool: ext.name, ok: true, summary: `${ext.source}: ${ext.name}`, data: text.length > 2000 ? undefined : data });
      return { content: clip(text, MAX_RESULT_CHARS), ok: true };
    } catch (e) {
      if (o.signal?.aborted) throw new Aborted();
      const msg = e instanceof HostEditError || e instanceof ToolError || e instanceof Error ? e.message : String(e);
      o.emit({ type: 'tool_result', id, role, tool: ext.name, ok: false, summary: msg });
      return { content: JSON.stringify({ ok: false, error: msg }), ok: false };
    }
  }

  async function execute(role: Role, call: ToolCall, depth: number): Promise<{ content: string; ok: boolean }> {
    const ext = role === 'director' ? externalByName.get(call.name) : undefined;
    if (ext) return executeExternal(role, call, ext, call.id || `t${++state.ids}`);
    const def = call.name === 'delegate' ? delegateTool : TOOLS.get(call.name);
    const allowed = ROLES[role].tools.includes(call.name);
    const id = call.id || `t${++state.ids}`;
    if (!def || !allowed) {
      const msg = `Unknown tool "${call.name}". Available: ${ROLES[role].tools.join(', ')}.`;
      o.emit({ type: 'tool_call', id, role, tool: call.name, args: call.arguments, scope: 'read' });
      o.emit({ type: 'tool_result', id, role, tool: call.name, ok: false, summary: msg });
      return { content: JSON.stringify({ ok: false, error: msg }), ok: false };
    }
    o.emit({ type: 'tool_call', id, role, tool: def.name, args: call.arguments, scope: def.scope });
    const parsed = def.schema.safeParse(call.arguments);
    if (!parsed.success) {
      const msg = `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`;
      o.emit({ type: 'tool_result', id, role, tool: def.name, ok: false, summary: msg });
      return { content: JSON.stringify({ ok: false, error: msg }), ok: false };
    }
    if (def.scope === 'edit' && !state.approveAll) {
      const summary = summarizeCall(def.name, call.arguments);
      o.emit({ type: 'approval', request: { id, role, tool: def.name, args: call.arguments, summary } });
      const decision = await o.approve({ id, role, tool: def.name, args: call.arguments, summary });
      if (o.signal?.aborted) throw new Aborted();
      if (decision === 'always') state.approveAll = true;
      if (!decision) {
        const msg = 'The user declined this edit. Do not retry it unchanged; adapt or explain.';
        o.emit({ type: 'tool_result', id, role, tool: def.name, ok: false, summary: 'Declined' });
        return { content: JSON.stringify({ ok: false, declined: true, error: msg }), ok: false };
      }
    }
    try {
      const data = def.name === 'delegate' ? await delegate(parsed.data as { role: Role; task: string }, depth) : await def.run(ctx(role), parsed.data);
      const text = JSON.stringify(data);
      o.emit({ type: 'tool_result', id, role, tool: def.name, ok: true, summary: def.scope === 'edit' ? summarizeCall(def.name, call.arguments) : def.name, data: text.length > 2000 ? undefined : data });
      return { content: clip(text, MAX_RESULT_CHARS), ok: true };
    } catch (e) {
      if (e instanceof Aborted) throw e;
      if (o.signal?.aborted) throw new Aborted();
      const msg = e instanceof ToolError ? e.message : e instanceof HostEditError ? e.message : `Unexpected error: ${(e as Error).message}`;
      const details = e instanceof HostEditError ? e.details : e instanceof ToolError ? e.details : undefined;
      o.emit({ type: 'tool_result', id, role, tool: def.name, ok: false, summary: msg });
      return { content: JSON.stringify({ ok: false, error: msg, ...(details ? { details } : {}) }), ok: false };
    }
  }

  async function loop(role: Role, messages: ChatMessage[], maxSteps: number, depth: number): Promise<string> {
    const tools = toolSpecsFor(role, external);
    let final = '';
    for (let step = 0; step < maxSteps; step++) {
      if (o.signal?.aborted) throw new Aborted();
      let result;
      try {
        for await (const ev of host.llm.stream({ model: o.model, messages, tools, effort: o.effort, maxTokens: 8192 }, o.signal)) {
          if (ev.type === 'text') o.emit({ type: 'text', role, delta: ev.delta });
          else if (ev.type === 'thinking') o.emit({ type: 'thinking', role, delta: ev.delta });
          else result = ev.result;
        }
      } catch (e) {
        if (o.signal?.aborted) throw new Aborted();
        throw e;
      }
      if (!result) throw new Error('The model returned no result.');
      if (o.signal?.aborted) throw new Aborted(); // stopped while the model was answering: do not run its pending tool calls
      o.emit({ type: 'usage', inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, contextTokens: result.usage.inputTokens + result.usage.outputTokens || estimateTokens(messages, tools) });
      messages.push({ role: 'assistant', content: result.text, ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}), ...(result.providerData ? { providerData: result.providerData } : {}) });
      if (result.text) final = result.text;
      if (!result.toolCalls.length) return final;
      for (const call of result.toolCalls) {
        const r = await execute(role, call, depth);
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: r.content });
      }
    }
    return final ? `${final}\n\n(Stopped after ${maxSteps} steps.)` : `Stopped after ${maxSteps} steps without finishing.`;
  }

  async function delegate(a: { role: Role; task: string }, depth: number): Promise<unknown> {
    if (depth >= 1) throw new ToolError('Specialists cannot delegate further.');
    const spec = ROLES[a.role];
    const msgs: ChatMessage[] = [
      { role: 'system', content: `${PREAMBLE}\n\n${spec.prompt}\n\n${contextLine(host)}` },
      { role: 'user', content: a.task },
    ];
    o.emit({ type: 'run_start', runId: `${o.runId}:${a.role}`, role: a.role, prompt: a.task });
    const report = await loop(a.role, msgs, 20, depth + 1);
    return { role: a.role, report };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: `${PREAMBLE}\n\n${ROLES.director.prompt}\n\n${contextLine(host, 'director', external)}` },
    ...(o.history ?? []),
    { role: 'user', content: expandSkillCommand(o.prompt, host.skills?.() ?? []) },
  ];
  const start = messages.length - 1;
  let summary = '';
  let cancelled = false;
  try {
    summary = await loop('director', messages, o.maxSteps ?? 40, 0);
    for (let round = 1; round <= QA_ROUNDS && state.edits > 0; round++) {
      const issues = qaCheck(host, before);
      if (!issues.length) break;
      o.emit({ type: 'qa', round, issues: issues.map(({ severity, code, message }) => ({ severity, code, message })) });
      messages.push({
        role: 'user',
        content: `Automatic QA found problems that were not there before your edits:\n${issues.slice(0, 15).map((i) => `- [${i.severity}] ${i.code}: ${i.message}`).join('\n')}\nFix the ones that are real problems. If something is intentional (for example a deliberate gap), leave it and say so. Then finish.`,
      });
      summary = await loop('director', messages, 12, 0);
    }
  } catch (e) {
    if (e instanceof Aborted) cancelled = true;
    else {
      const message = e instanceof Error ? e.message : String(e);
      o.emit({ type: 'error', message });
      summary = `Stopped: ${message}`;
    }
  }
  o.emit({ type: 'done', runId: o.runId, summary, group, edits: state.edits, cancelled, revisionFrom: state.firstRev, revisionTo: state.lastRev });
  return { summary, group, edits: state.edits, cancelled, messages: messages.slice(1).slice(start - 1) };
}
