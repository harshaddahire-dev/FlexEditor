import { z } from 'zod';
import type { Media, Op, Sequence, ToolScope } from '@cutroom/core';
import type { Skill } from './skill';

export type AnalysisKind = 'transcript' | 'silences' | 'scenes' | 'beats' | 'loudness';

/** What a plugin tool may do. Edits go through the same validated engine and the same undo group as the agent's own. */
export interface PluginContext {
  sequence(): Sequence;
  media(): Media[];
  analysis(mediaId: string, kind: AnalysisKind): Promise<unknown | null>;
  /** One atomic transaction; throws with a reason the model can act on when the engine refuses it. */
  applyOps(ops: Op[], opts: { label: string }): { revision: number };
  log(message: string): void;
  signal?: AbortSignal;
}

/** A tool as the runtime sees it: JSON Schema parameters, whatever its source (plugin, MCP server…). */
export interface ExternalTool {
  /** Unique, model-safe: letters, digits, `_` and `-`. */
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  scope: ToolScope;
  /** `plugin:<id>` or `mcp:<server>` — shown on the approval/transcript card. */
  source: string;
  call(args: Record<string, unknown>, ctx: PluginContext): Promise<unknown>;
}

export interface PluginToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /** Validates and types the arguments; also becomes the JSON Schema the model sees. */
  schema?: S;
  /** Plain JSON Schema, for plugins that do not want a zod dependency. */
  parameters?: Record<string, unknown>;
  /** 'read' (default) never asks for approval; 'edit' does in Ask mode. */
  scope?: ToolScope;
  run(ctx: PluginContext, args: S extends z.ZodType ? z.infer<S> : Record<string, unknown>): Promise<unknown> | unknown;
}

export interface PluginDefinition {
  id: string;
  name: string;
  version: string;
  description?: string;
  tools?: PluginToolDef[];
  /** Skills the plugin ships (same format as SKILL.md files). */
  skills?: Omit<Skill, 'source'>[];
}

/** Identity helper that type-checks a plugin definition: `export default definePlugin({...})`. */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

export const defineTool = <S extends z.ZodType>(t: PluginToolDef<S>): PluginToolDef<S> => t;

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes'),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  main: z.string().default('index.mjs'),
});
export type PluginManifest = z.infer<typeof manifestSchema>;

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
/** `<prefix>__<tool>` names stay unique across plugins and MCP servers and valid for every provider (≤ 64 chars). */
export const toolName = (prefix: string, tool: string): string => `${safe(prefix)}__${safe(tool)}`.slice(0, 64);

const isZod = (s: unknown): s is z.ZodType => !!s && typeof (s as { safeParse?: unknown }).safeParse === 'function';

/** Turn a loaded plugin definition into runtime tools (namespaced, schema-checked). */
export function pluginTools(def: PluginDefinition): ExternalTool[] {
  return (def.tools ?? []).map((t) => {
    const zod = isZod(t.schema) ? t.schema : undefined;
    const parameters = zod ? ((): Record<string, unknown> => { const j = z.toJSONSchema(zod, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j; })() : (t.parameters ?? { type: 'object', properties: {} });
    return {
      name: toolName(`plugin_${def.id}`, t.name),
      description: `[${def.name}] ${t.description}`,
      parameters,
      scope: t.scope ?? 'read',
      source: `plugin:${def.id}`,
      call: async (args, ctx) => {
        const parsed = zod ? zod.safeParse(args) : { success: true as const, data: args };
        if (!parsed.success) throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`);
        return (t.run as (c: PluginContext, a: unknown) => unknown)(ctx, parsed.data);
      },
    };
  });
}

/** Check the shape of a module's default export before trusting it. */
export function validatePlugin(def: unknown, manifest: PluginManifest): PluginDefinition {
  const d = def as PluginDefinition | undefined;
  if (!d || typeof d !== 'object') throw new Error('The plugin must `export default definePlugin({...})`.');
  if (d.id !== manifest.id) throw new Error(`Plugin id "${String(d.id)}" does not match plugin.json ("${manifest.id}").`);
  for (const t of d.tools ?? []) {
    if (!t || typeof t.name !== 'string' || typeof t.run !== 'function' || typeof t.description !== 'string') throw new Error('Every tool needs a name, description and run().');
  }
  return d;
}
