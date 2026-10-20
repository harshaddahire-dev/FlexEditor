import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type AgentHost, HostEditError, runAgent } from '@cutroom/agents';
import { type ApprovalRequest, type ChatMessage, type ChatState, type ChatTurn, type Media, type Op, type RunEvent, type Sequence, compactEvents, diffIsEmpty, diffSequences, trackItems } from '@cutroom/core';
import { EditRequestError, type EditSession } from '../edit';
import type { ExtensionService } from '../extensions';
import type { ProviderService } from '../providers';

type Decision = boolean | 'always';

export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/** What the service needs from the project manager. */
export interface AgentProject {
  folder(): string | null;
  session(): EditSession;
  media(): Media[];
  /** Absolute path of a cached analysis JSON, if it exists. */
  analysisPath(mediaId: string, name: string): string | null;
}

interface Active {
  turn: ChatTurn;
  abort: AbortController;
  pending: Map<string, (d: Decision) => void>;
  done: Promise<void>;
}

const ANALYSIS_FILE: Record<string, string> = { transcript: 'transcript', silences: 'silences', scenes: 'scenes', beats: 'beats', loudness: 'loudness' };

/**
 * Runs the agents against the open project. One run at a time; its events stream to the browser, approvals wait for
 * the user, and the transcript (with what each run changed) is kept in `.cutroom/chat.json` so the conversation
 * survives a restart.
 */
export class AgentService {
  private chat: ChatState = { turns: [] };
  private loadedFor: string | null = null;
  private active: Active | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly project: AgentProject,
    private readonly providers: ProviderService,
    private readonly extensions: ExtensionService,
    private readonly broadcast: (e: { type: 'agent'; kind: 'event'; runId: string; event: RunEvent } | { type: 'agent'; kind: 'turn'; turn: ChatTurn }) => void,
  ) {}

  private file(): string | null {
    const f = this.project.folder();
    return f ? path.join(f, '.cutroom', 'chat.json') : null;
  }

  private async load(): Promise<void> {
    const f = this.project.folder();
    if (f === this.loadedFor) return;
    this.loadedFor = f;
    this.chat = { turns: [] };
    const file = this.file();
    if (!file) return;
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8')) as ChatState;
      // a run that was in flight when the server stopped cannot continue
      for (const t of saved.turns) if (t.status === 'running') (t.status = 'error'), (t.summary = 'Interrupted: the app was closed during this run.'), delete t.pending;
      this.chat = { turns: saved.turns };
    } catch {
      /* no chat yet */
    }
  }

  private persist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 300);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const file = this.file();
    if (!file) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const turns = this.chat.turns.slice(-60);
    await fs.writeFile(file, JSON.stringify({ turns }));
  }

  async state(): Promise<ChatState> {
    await this.load();
    return { turns: this.chat.turns, ...(this.active ? { activeRunId: this.active.turn.runId } : {}) };
  }

  private turnOf(runId: string): ChatTurn {
    const t = this.chat.turns.find((x) => x.runId === runId);
    if (!t) throw new AgentError('no_such_run', 'No such run.', 404);
    return t;
  }

  private pushTurn(t: ChatTurn): void {
    this.broadcast({ type: 'agent', kind: 'turn', turn: t });
    this.persist();
  }

  /** The host the agents use: the same EditSession and caches as the rest of the app. */
  private host(): AgentHost {
    const session = this.project.session();
    return {
      llm: { stream: (req, signal) => this.providers.stream(this.requireSettings().providerId, req, signal) },
      sequence: () => session.state,
      media: () => this.project.media(),
      env: session.editor.env,
      skills: () => this.extensions.skills(),
      externalTools: () => this.extensions.externalTools(),
      log: (m) => console.info(`[extension] ${m}`),
      applyOps: (ops, o) => {
        try {
          const r = session.edit({ ops: ops as Op[], label: o.label, origin: o.origin, group: o.group });
          return { revision: r.revision };
        } catch (e) {
          if (e instanceof EditRequestError) throw new HostEditError(e.message, e.code, e.details);
          throw e;
        }
      },
      analysis: async (mediaId, kind) => {
        const p = this.project.analysisPath(mediaId, ANALYSIS_FILE[kind]!);
        if (!p) return null;
        try {
          return JSON.parse(await fs.readFile(p, 'utf8'));
        } catch {
          return null;
        }
      },
    };
  }

  private requireSettings(): { providerId: string; model: string } {
    const s = this.providers.store.agent();
    if (!s.providerId || !this.providers.store.get(s.providerId)) throw new AgentError('no_provider', 'Connect a model provider first (Settings → Providers).');
    if (!s.model) throw new AgentError('no_model', 'Choose a model in the Agent panel first.');
    return { providerId: s.providerId, model: s.model };
  }

  async start(prompt: string): Promise<{ runId: string }> {
    await this.load();
    if (this.active) throw new AgentError('busy', 'The agent is already working. Stop it or wait for it to finish.', 409);
    const { model } = this.requireSettings();
    const settings = this.providers.store.agent();
    const session = this.project.session(); // throws if no project is open
    await this.extensions.refreshSkills();
    const runId = randomUUID().slice(0, 8);
    const turn: ChatTurn = { runId, prompt, at: Date.now(), status: 'running', events: [], edits: 0, review: 'pending', model };
    this.chat.turns.push(turn);
    const abort = new AbortController();
    const active: Active = { turn, abort, pending: new Map(), done: Promise.resolve() };
    this.active = active;
    const before = session.state;
    const raw: RunEvent[] = [];
    this.pushTurn(turn);

    // conversation memory: earlier prompts and what the agent answered (the timeline itself is re-read every run)
    const history: ChatMessage[] = this.chat.turns
      .filter((t) => t.runId !== runId && t.summary)
      .slice(-8)
      .flatMap((t) => [{ role: 'user', content: t.prompt } as ChatMessage, { role: 'assistant', content: t.summary! } as ChatMessage]);

    active.done = (async () => {
      try {
        const result = await runAgent(this.host(), {
          runId,
          prompt,
          history,
          mode: settings.mode,
          effort: settings.effort,
          model,
          signal: abort.signal,
          emit: (event) => {
            raw.push(event);
            this.broadcast({ type: 'agent', kind: 'event', runId, event });
            if (event.type === 'approval') {
              turn.pending = event.request;
              this.pushTurn(turn);
            }
          },
          approve: (req: ApprovalRequest) =>
            new Promise<Decision>((resolve) => {
              active.pending.set(req.id, (d) => {
                active.pending.delete(req.id);
                delete turn.pending;
                resolve(d);
              });
              if (abort.signal.aborted) resolve(false);
            }),
        });
        turn.status = result.cancelled ? 'cancelled' : raw.some((e) => e.type === 'error') ? 'error' : 'done';
        turn.summary = result.summary;
        turn.group = result.group;
        turn.edits = result.edits;
      } catch (e) {
        turn.status = 'error';
        turn.summary = e instanceof Error ? e.message : String(e);
      } finally {
        turn.events = compactEvents(raw).slice(-2000);
        const d = diffSequences(before, session.state);
        if (!diffIsEmpty(d)) turn.diff = d;
        else turn.review = 'dismissed';
        delete turn.pending;
        this.active = null;
        await this.flush().catch(() => undefined);
        this.pushTurn(turn);
      }
    })();
    return { runId };
  }

  decide(runId: string, requestId: string, decision: Decision): void {
    const a = this.active;
    if (!a || a.turn.runId !== runId) throw new AgentError('no_such_run', 'That run is not active.', 404);
    const resolve = a.pending.get(requestId);
    if (!resolve) throw new AgentError('no_such_request', 'That approval is no longer pending.', 404);
    resolve(decision);
  }

  cancel(runId: string): void {
    const a = this.active;
    if (!a || a.turn.runId !== runId) throw new AgentError('no_such_run', 'That run is not active.', 404);
    a.abort.abort();
    for (const resolve of [...a.pending.values()]) resolve(false);
  }

  /** Wait for the active run (tests, shutdown). */
  async idle(): Promise<void> {
    await this.active?.done;
  }

  /** The user keeps this run's edits: mark every agent-made item accepted. */
  async accept(runId: string): Promise<ChatTurn> {
    await this.load();
    const turn = this.turnOf(runId);
    const session = this.project.session();
    const ids: string[] = [];
    for (const t of session.state.tracks) for (const item of trackItems(t)) if (item.createdBy !== 'user' && !item.accepted) ids.push(item.id);
    if (ids.length) session.edit({ ops: [{ type: 'accept', itemIds: ids }], label: 'Accept agent edits', origin: 'user' });
    turn.review = 'accepted';
    this.pushTurn(turn);
    return turn;
  }

  async undo(runId: string): Promise<ChatTurn> {
    await this.load();
    const turn = this.turnOf(runId);
    if (!turn.group) throw new AgentError('nothing_to_undo', 'This run made no edits.');
    const { count } = this.project.session().undoGroup(turn.group);
    if (count === 0) throw new AgentError('cannot_undo', 'These edits are no longer at the top of the history — undo the newer edits first (or use the History).', 409);
    turn.review = 'undone';
    this.pushTurn(turn);
    return turn;
  }

  async dismiss(runId: string): Promise<ChatTurn> {
    await this.load();
    const turn = this.turnOf(runId);
    turn.review = 'dismissed';
    this.pushTurn(turn);
    return turn;
  }

  async clear(): Promise<void> {
    await this.load();
    if (this.active) throw new AgentError('busy', 'Stop the running agent first.', 409);
    this.chat = { turns: [] };
    await this.flush();
  }
}
