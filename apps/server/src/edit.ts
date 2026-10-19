import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type EditEnv,
  type EditRequest,
  type EditResponse,
  Editor,
  EditError,
  type HistoryState,
  type Media,
  type MediaRef,
  type Origin,
  type Sequence,
  type SnapshotInfo,
  type Timebase,
  type Transaction,
  type TransactionInfo,
  tbSecondsToTicks,
} from '@cutroom/core';

/** A rejected edit request: which operation failed and why, in a form an agent can act on. */
export class EditRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'EditRequestError';
  }
}

/** What the engine needs to know about a media file, expressed in the sequence's ticks. */
export function mediaRef(m: Media, tb: Timebase): MediaRef {
  const isImage = m.type === 'image';
  return {
    id: m.id,
    kind: m.type,
    duration: isImage ? null : tbSecondsToTicks(m.duration, tb, 'floor'),
    hasVideo: m.type === 'video' || isImage,
    hasAudio: !!m.audio,
  };
}

const info = (t: Transaction): TransactionInfo => ({ id: t.id, label: t.label, origin: t.origin, revision: t.revision, at: t.at, opCount: t.ops.length });

const ORIGIN = /^(user|agent:[a-z0-9_-]+)$/i;

/** Keeps one named snapshot of the sequence per agent transaction, so the History panel can jump back to any turn. */
class SnapshotStore {
  private index: SnapshotInfo[] = [];
  private loading: Promise<void> | null = null;
  constructor(private readonly dir: string) {}

  /** Read the index once; concurrent callers share the same read so nothing can overwrite a later `add`. */
  private load(): Promise<void> {
    this.loading ??= fs.readFile(path.join(this.dir, 'index.json'), 'utf8').then(
      (raw) => void (this.index = JSON.parse(raw) as SnapshotInfo[]),
      () => void (this.index = []),
    );
    return this.loading;
  }

  async list(): Promise<SnapshotInfo[]> {
    await this.load();
    return this.index;
  }

  async add(meta: SnapshotInfo, seq: Sequence): Promise<void> {
    await this.load();
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, `${meta.id}.json`), JSON.stringify(seq));
    this.index.push(meta);
    await fs.writeFile(path.join(this.dir, 'index.json'), JSON.stringify(this.index, null, 2));
  }

  async read(id: string): Promise<Sequence | null> {
    await this.load();
    if (!this.index.some((s) => s.id === id)) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, `${id}.json`), 'utf8')) as Sequence;
    } catch {
      return null;
    }
  }
}

export type SessionEvent =
  | { type: 'sequence'; kind: 'commit' | 'undo' | 'redo' | 'load'; revision: number; patches: unknown[]; sequence?: Sequence }
  | { type: 'history' };

/** The authoritative sequence + its transactional history. All edits — UI, agents, plugins — pass through here. */
export class EditSession {
  readonly editor: Editor;
  private readonly snapshots: SnapshotStore;
  private snapshotsInfo: SnapshotInfo[] = [];
  private pendingSnapshots: Promise<unknown> = Promise.resolve();

  constructor(
    sequence: Sequence,
    getMedia: (id: string) => Media | undefined,
    historyDir: string,
    private readonly onEvent: (e: SessionEvent) => void,
  ) {
    const env: EditEnv = {
      getMedia: (id) => {
        const m = getMedia(id);
        return m ? mediaRef(m, this.editor.state.timebase) : undefined;
      },
    };
    this.editor = new Editor(sequence, env);
    this.snapshots = new SnapshotStore(historyDir);
    // existing snapshots from earlier sessions; keep any added since construction
    void this.snapshots.list().then((l) => (this.snapshotsInfo = [...l, ...this.snapshotsInfo.filter((s) => !l.some((x) => x.id === s.id))]));
    this.editor.subscribe((e) => {
      this.onEvent({ type: 'sequence', kind: e.type, revision: e.revision, patches: e.patches, ...(e.type === 'load' ? { sequence: e.state } : {}) });
      this.onEvent({ type: 'history' });
      if (e.type === 'commit' && e.transaction && e.transaction.origin !== 'user') this.snapshot(e.transaction, e.state);
    });
  }

  private snapshot(tx: Transaction, seq: Sequence): void {
    const meta: SnapshotInfo = { id: `${tx.at}-r${tx.revision}`, label: tx.label, origin: tx.origin, revision: tx.revision, at: tx.at };
    this.snapshotsInfo.push(meta);
    this.pendingSnapshots = this.pendingSnapshots.then(() => this.snapshots.add(meta, seq)).catch((e) => console.error('[history] snapshot failed:', e));
  }

  /** Resolves when queued snapshot writes are on disk (tests, shutdown). */
  flush(): Promise<unknown> {
    return this.pendingSnapshots;
  }

  get state(): Sequence {
    return this.editor.state;
  }

  history(): HistoryState {
    return {
      canUndo: this.editor.canUndo,
      canRedo: this.editor.canRedo,
      undo: this.editor.history.map(info),
      redo: this.editor.redoable.map(info),
      snapshots: this.snapshotsInfo,
    };
  }

  /** Apply `req.ops` as ONE transaction: all succeed or none do. */
  edit(req: EditRequest): EditResponse {
    if (req.baseRevision !== undefined && req.baseRevision !== this.editor.revision) {
      throw new EditRequestError(409, 'stale', `The sequence is at revision ${this.editor.revision}, not ${req.baseRevision}. Refresh and retry.`, { revision: this.editor.revision });
    }
    const origin = (req.origin ?? 'user') as Origin;
    if (!ORIGIN.test(origin)) throw new EditRequestError(400, 'bad_origin', `origin must be "user" or "agent:<name>", got "${origin}".`);
    if (!Array.isArray(req.ops) || req.ops.length === 0) throw new EditRequestError(400, 'no_ops', 'ops must be a non-empty array.');

    this.editor.begin(req.label ?? defaultLabel(req.ops), origin);
    let patches: unknown[] = [];
      try {
      req.ops.forEach((op, opIndex) => {
        try {
          this.editor.apply(op as never);
        } catch (e) {
          if (e instanceof EditError) {
            throw new EditRequestError(422, 'edit_invalid', `Operation ${opIndex + 1} (${(op as { type?: string })?.type ?? '?'}) was rejected: ${e.message}`, { code: e.code, opIndex, details: e.details ?? {} });
          }
          throw e;
        }
      });
    } catch (e) {
      this.editor.rollback();
      throw e;
    }
    const tx = this.editor.commit(req.label);
    if (tx) patches = tx.patches;
    return { revision: this.editor.revision, transaction: tx ? info(tx) : null, patches: patches as never, history: this.history() };
  }

  undo(): { revision: number; label: string | null } {
    const tx = this.editor.undo();
    return { revision: this.editor.revision, label: tx?.label ?? null };
  }

  redo(): { revision: number; label: string | null } {
    const tx = this.editor.redo();
    return { revision: this.editor.revision, label: tx?.label ?? null };
  }

  async restore(snapshotId: string): Promise<EditResponse> {
    await this.flush();
    const seq = await this.snapshots.read(snapshotId);
    const meta = this.snapshotsInfo.find((s) => s.id === snapshotId);
    if (!seq || !meta) throw new EditRequestError(404, 'no_snapshot', `No snapshot "${snapshotId}".`);
    const tx = this.editor.replaceState(seq, `Restore “${meta.label}”`);
    return { revision: this.editor.revision, transaction: tx ? info(tx) : null, patches: (tx?.patches ?? []) as never, history: this.history() };
  }
}

function defaultLabel(ops: unknown[]): string {
  const types = [...new Set(ops.map((o) => (o as { type?: string })?.type ?? 'edit'))];
  return types.length === 1 ? `${types[0]}${ops.length > 1 ? ` ×${ops.length}` : ''}` : `${ops.length} edits`;
}
