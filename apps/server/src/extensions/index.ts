import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionsInfo, McpServerInfo, McpServerInput, SkillInfo } from '@cutroom/core';
import type { ExternalTool, Skill } from '@cutroom/plugin-sdk';
import { SecretBox } from '../providers/secrets';
import { McpClient } from './mcp';
import { type LoadedPlugin, loadPluginsFrom } from './plugins';
import { loadSkillsFrom } from './skills';

export class ExtensionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ExtensionError';
  }
}

interface StoredMcp {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  /** values sealed with the app's master key */
  env: Record<string, string>;
  headers: Record<string, string>;
  enabled: boolean;
}

interface Stored {
  disabled: { skills: string[]; plugins: string[] };
  mcp: StoredMcp[];
}

interface Live {
  client: McpClient;
  status: 'connecting' | 'ready' | 'error';
  error?: string;
  done: Promise<void>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Skills, plugins and MCP servers. Built-in ones ship in the repo; users add their own in the app's data folder (or
 * `<project>/.cutroom/skills`). Settings (what is switched off, MCP server definitions with their secrets sealed)
 * live in `<data>/extensions.json`.
 */
export class ExtensionService {
  private stored: Stored = { disabled: { skills: [], plugins: [] }, mcp: [] };
  private skillList: Skill[] = [];
  private pluginList: LoadedPlugin[] = [];
  private live = new Map<string, Live>();
  private errors: string[] = [];
  private readonly box: SecretBox;
  private readonly file: string;

  constructor(
    private readonly opts: {
      dataDir: string;
      /** Folder holding the built-in `skills/` and `plugins/`. */
      builtinRoot: string | null;
      projectFolder: () => string | null;
    },
  ) {
    this.box = new SecretBox(path.join(opts.dataDir, 'secret.key'));
    this.file = path.join(opts.dataDir, 'extensions.json');
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Stored>;
      this.stored = { disabled: { skills: s.disabled?.skills ?? [], plugins: s.disabled?.plugins ?? [] }, mcp: s.mcp ?? [] };
    } catch {
      /* first run */
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.stored, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private skillDirs(): { dir: string; source: string }[] {
    const proj = this.opts.projectFolder();
    return [
      ...(this.opts.builtinRoot ? [{ dir: path.join(this.opts.builtinRoot, 'skills'), source: 'builtin' }] : []),
      { dir: path.join(this.opts.dataDir, 'skills'), source: 'user' },
      ...(proj ? [{ dir: path.join(proj, '.cutroom', 'skills'), source: 'project' }] : []),
    ];
  }

  private pluginDirs(): string[] {
    return [...(this.opts.builtinRoot ? [path.join(this.opts.builtinRoot, 'plugins')] : []), path.join(this.opts.dataDir, 'plugins')];
  }

  private loading: Promise<void> = Promise.resolve();

  /** Load in the background at startup; everything that reads waits for it. */
  start(): void {
    this.loading = this.reload().catch((e) => void (this.errors = [`Could not load extensions: ${(e as Error).message}`]));
  }

  /** Re-read skill folders (cheap; done before every agent run so edits show up immediately). */
  async refreshSkills(): Promise<void> {
    await this.loading;
    await this.scanSkills();
  }

  private async scanSkills(): Promise<void> {
    const byName = new Map<string, Skill>();
    const errors: string[] = [];
    for (const { dir, source } of this.skillDirs()) {
      const r = await loadSkillsFrom(dir, source);
      errors.push(...r.errors);
      for (const s of r.skills) byName.set(s.name, s); // later folders override earlier ones
    }
    for (const p of this.pluginList) if (!this.stored.disabled.plugins.includes(p.id)) for (const s of p.skills) if (!byName.has(s.name)) byName.set(s.name, s);
    this.skillList = [...byName.values()];
    this.errors = errors;
  }

  /** Load everything: skills, plugins (re-importing their code) and MCP connections. */
  async reload(): Promise<void> {
    for (const l of this.live.values()) l.client.close();
    this.live.clear();
    const lists = await Promise.all(this.pluginDirs().map((d) => loadPluginsFrom(d)));
    const seen = new Set<string>();
    this.pluginList = lists.flat().filter((p) => !seen.has(p.id) && !!seen.add(p.id));
    await this.scanSkills();
    for (const s of this.stored.mcp) if (s.enabled) this.connect(s);
  }

  private open(map: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      const plain = this.box.open(v);
      if (plain !== null) out[k] = plain;
    }
    return out;
  }

  private connect(s: StoredMcp): void {
    const client = new McpClient({ id: s.id, transport: s.transport, command: s.command, args: s.args, url: s.url, env: this.open(s.env), headers: this.open(s.headers) });
    const live: Live = { client, status: 'connecting', done: Promise.resolve() };
    live.done = client.connect().then(
      () => void (live.status = 'ready'),
      (e: Error) => {
        live.status = 'error';
        live.error = e.message;
      },
    );
    this.live.set(s.id, live);
  }

  /** Resolves when every MCP connection attempt has finished (tests, "Test connection"). */
  async settled(): Promise<void> {
    await this.loading;
    await Promise.all([...this.live.values()].map((l) => l.done));
  }

  skills(): Skill[] {
    return this.skillList.filter((s) => !this.stored.disabled.skills.includes(s.name) && !(s.source.startsWith('plugin:') && this.stored.disabled.plugins.includes(s.source.slice(7))));
  }

  externalTools(): ExternalTool[] {
    const out: ExternalTool[] = [];
    for (const p of this.pluginList) if (p.status === 'ready' && !this.stored.disabled.plugins.includes(p.id)) out.push(...p.tools);
    for (const s of this.stored.mcp) {
      const l = this.live.get(s.id);
      if (s.enabled && l?.status === 'ready') out.push(...l.client.externalTools(s.name));
    }
    return out;
  }

  info(): ExtensionsInfo {
    const skills: SkillInfo[] = this.skillList.map((s) => ({ name: s.name, description: s.description, source: s.source, body: s.body, enabled: !this.stored.disabled.skills.includes(s.name) }));
    return {
      skills,
      plugins: this.pluginList.map((p) => {
        const enabled = !this.stored.disabled.plugins.includes(p.id);
        return {
          id: p.id,
          name: p.name,
          version: p.version,
          ...(p.description ? { description: p.description } : {}),
          enabled,
          status: !enabled ? 'disabled' : p.status,
          ...(p.error ? { error: p.error } : {}),
          tools: p.tools.map((t) => ({ name: t.name, description: t.description, scope: t.scope })),
          skills: p.skills.map((s) => s.name),
          dir: p.dir,
        };
      }),
      mcp: this.stored.mcp.map((s): McpServerInfo => {
        const l = this.live.get(s.id);
        return {
          id: s.id,
          name: s.name,
          transport: s.transport,
          ...(s.command ? { command: s.command } : {}),
          ...(s.args?.length ? { args: s.args } : {}),
          ...(s.url ? { url: s.url } : {}),
          envKeys: Object.keys(s.env),
          headerKeys: Object.keys(s.headers),
          enabled: s.enabled,
          status: !s.enabled ? 'disabled' : (l?.status ?? 'connecting'),
          ...(l?.error ? { error: l.error } : {}),
          tools: l?.status === 'ready' ? l.client.tools.map((t) => ({ name: t.name, description: t.description ?? '' })) : [],
        };
      }),
      dirs: { skills: this.skillDirs().map((d) => d.dir), plugins: this.pluginDirs() },
      errors: this.errors,
    };
  }

  setSkillEnabled(name: string, enabled: boolean): void {
    if (!this.skillList.some((s) => s.name === name)) throw new ExtensionError('no_such_skill', `No skill "${name}".`, 404);
    const set = new Set(this.stored.disabled.skills);
    if (enabled) set.delete(name);
    else set.add(name);
    this.stored.disabled.skills = [...set];
    this.save();
  }

  setPluginEnabled(id: string, enabled: boolean): void {
    if (!this.pluginList.some((p) => p.id === id)) throw new ExtensionError('no_such_plugin', `No plugin "${id}".`, 404);
    const set = new Set(this.stored.disabled.plugins);
    if (enabled) set.delete(id);
    else set.add(id);
    this.stored.disabled.plugins = [...set];
    this.save();
  }

  private seal(map: Record<string, string> | undefined, previous: Record<string, string> = {}): Record<string, string> {
    const out = { ...previous };
    for (const [k, v] of Object.entries(map ?? {})) {
      if (!k.trim()) continue;
      if (v === '') delete out[k];
      else out[k.trim()] = this.box.seal(v);
    }
    return out;
  }

  upsertMcp(input: McpServerInput): McpServerInfo {
    const name = input.name?.trim();
    if (!name) throw new ExtensionError('bad_request', 'Give the server a name.');
    if (input.transport === 'stdio' && !input.command?.trim()) throw new ExtensionError('bad_request', 'A stdio server needs a command.');
    if (input.transport === 'http' && !/^https?:\/\//i.test(input.url ?? '')) throw new ExtensionError('bad_request', 'An HTTP server needs an http(s) URL.');
    if (input.transport !== 'stdio' && input.transport !== 'http') throw new ExtensionError('bad_request', 'Transport must be stdio or http.');
    const existing = input.id ? this.stored.mcp.find((m) => m.id === input.id) : undefined;
    if (input.id && !existing) throw new ExtensionError('no_such_server', 'No such MCP server.', 404);
    const id = existing?.id ?? this.freshId(name);
    const next: StoredMcp = {
      id,
      name,
      transport: input.transport,
      ...(input.transport === 'stdio' ? { command: input.command!.trim(), args: input.args ?? [] } : { url: input.url!.trim() }),
      env: input.transport === 'stdio' ? this.seal(input.env, existing?.env) : {},
      headers: input.transport === 'http' ? this.seal(input.headers, existing?.headers) : {},
      enabled: input.enabled ?? existing?.enabled ?? true,
    };
    this.stored.mcp = existing ? this.stored.mcp.map((m) => (m.id === id ? next : m)) : [...this.stored.mcp, next];
    this.save();
    this.live.get(id)?.client.close();
    this.live.delete(id);
    if (next.enabled) this.connect(next);
    return this.info().mcp.find((m) => m.id === id)!;
  }

  private freshId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'server';
    let id = ID.test(base) ? base : `s-${randomUUID().slice(0, 6)}`;
    for (let n = 2; this.stored.mcp.some((m) => m.id === id); n++) id = `${base}-${n}`;
    return id;
  }

  setMcpEnabled(id: string, enabled: boolean): McpServerInfo {
    const s = this.stored.mcp.find((m) => m.id === id);
    if (!s) throw new ExtensionError('no_such_server', 'No such MCP server.', 404);
    s.enabled = enabled;
    this.save();
    this.live.get(id)?.client.close();
    this.live.delete(id);
    if (enabled) this.connect(s);
    return this.info().mcp.find((m) => m.id === id)!;
  }

  removeMcp(id: string): void {
    if (!this.stored.mcp.some((m) => m.id === id)) throw new ExtensionError('no_such_server', 'No such MCP server.', 404);
    this.live.get(id)?.client.close();
    this.live.delete(id);
    this.stored.mcp = this.stored.mcp.filter((m) => m.id !== id);
    this.save();
  }

  /** Reconnect one server and report how it went. */
  async retryMcp(id: string): Promise<McpServerInfo> {
    const s = this.stored.mcp.find((m) => m.id === id);
    if (!s) throw new ExtensionError('no_such_server', 'No such MCP server.', 404);
    this.live.get(id)?.client.close();
    this.live.delete(id);
    this.connect(s);
    await this.live.get(id)!.done;
    return this.info().mcp.find((m) => m.id === id)!;
  }

  close(): void {
    for (const l of this.live.values()) l.client.close();
    this.live.clear();
  }
}
