import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { type ExternalTool, toolName } from '@cutroom/plugin-sdk';

/**
 * A small Model Context Protocol client: JSON-RPC 2.0 over a child process's stdio (newline-delimited) or over
 * streamable HTTP. It speaks just enough for tools: initialize, tools/list, tools/call.
 */
export interface McpConfig {
  id: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

const PROTOCOL = '2024-11-05';
const INIT_TIMEOUT = 15_000;
const CALL_TIMEOUT = 60_000;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessionId: string | null = null;
  private stderr = '';
  private ready: Promise<void> | null = null;
  tools: McpToolInfo[] = [];

  constructor(private readonly cfg: McpConfig) {}

  /** Connect (once), run the handshake and list the tools. */
  connect(): Promise<void> {
    this.ready ??= this.handshake().catch((e) => {
      this.ready = null;
      this.close();
      throw e;
    });
    return this.ready;
  }

  private async handshake(): Promise<void> {
    if (this.cfg.transport === 'stdio') this.spawnProcess();
    await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'cutroom', version: '0.1.0' } }, INIT_TIMEOUT);
    await this.notify('notifications/initialized');
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const r = (await this.request('tools/list', cursor ? { cursor } : {}, INIT_TIMEOUT)) as { tools?: McpToolInfo[]; nextCursor?: string };
      tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor && tools.length < 500);
    this.tools = tools;
  }

  private spawnProcess(): void {
    const { command, args = [], env = {} } = this.cfg;
    if (!command) throw new Error('No command set for this MCP server.');
    const proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => this.onData(d));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-2000)));
    proc.on('error', (e) => this.failAll(new Error(`Could not start "${command}": ${e.message}`)));
    proc.on('exit', (code) => {
      this.proc = null;
      this.ready = null;
      this.failAll(new Error(`The MCP server exited${code === null ? '' : ` (code ${code})`}.${this.stderr.trim() ? ` ${this.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not protocol output (some servers log to stdout)
    }
    if (typeof msg.id !== 'number') return; // notifications / server requests are ignored
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
    else p.resolve(msg.result);
  }

  private failAll(e: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const body = { jsonrpc: '2.0', id, method, params };
    if (this.cfg.transport === 'http') return this.httpPost(body, id, timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${method}" timed out after ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.proc) return reject(new Error('The MCP server is not running.'));
      this.proc.stdin.write(`${JSON.stringify(body)}\n`, (err) => {
        if (err) reject(err);
      });
    });
  }

  private async notify(method: string): Promise<void> {
    const body = { jsonrpc: '2.0', method };
    if (this.cfg.transport === 'http') {
      await this.httpPost(body, null, INIT_TIMEOUT).catch(() => undefined);
      return;
    }
    this.proc?.stdin.write(`${JSON.stringify(body)}\n`);
  }

  private async httpPost(body: Record<string, unknown>, id: number | null, timeoutMs: number): Promise<unknown> {
    if (!this.cfg.url) throw new Error('No URL set for this MCP server.');
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}), ...this.cfg.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (id === null) return undefined;
    if (!res.ok) throw new Error(`MCP server answered HTTP ${res.status}.`);
    const text = await res.text();
    const messages: { id?: number; result?: unknown; error?: { message?: string } }[] = [];
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (data) try { messages.push(JSON.parse(data)); } catch { /* skip */ }
      }
    } else messages.push(JSON.parse(text));
    const m = messages.find((x) => x.id === id);
    if (!m) throw new Error('The MCP server sent no answer.');
    if (m.error) throw new Error(m.error.message ?? 'MCP error');
    return m.result;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.connect();
    const run = this.request('tools/call', { name, arguments: args }, CALL_TIMEOUT) as Promise<{ content?: { type: string; text?: string; mimeType?: string }[]; isError?: boolean; structuredContent?: unknown }>;
    const r = await (signal ? Promise.race([run, new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('Cancelled.')), { once: true }))]) : run);
    const text = (r.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''} omitted]`)).join('\n');
    if (r.isError) throw new Error(text || 'The MCP tool reported an error.');
    return r.structuredContent !== undefined ? { text, data: r.structuredContent } : { text };
  }

  close(): void {
    this.failAll(new Error('Disconnected.'));
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    if (p) {
      p.removeAllListeners('exit');
      p.stdin.end();
      setTimeout(() => p.kill(), 500).unref();
    }
  }

  /** The listed tools as runtime tools, namespaced by server id. */
  externalTools(serverName: string): ExternalTool[] {
    return this.tools.map((t) => ({
      name: toolName(`mcp_${this.cfg.id}`, t.name),
      description: `[${serverName}] ${t.description ?? t.name}`,
      parameters: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
      scope: t.annotations?.readOnlyHint ? 'read' : 'edit',
      source: `mcp:${this.cfg.id}`,
      call: (args, ctx) => this.callTool(t.name, args, ctx.signal),
    }));
  }
}
