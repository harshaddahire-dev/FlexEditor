import { freeze, produceWithPatches } from 'immer';
import { type Patch, applyPatches, applyOp } from './apply';
import { EditError } from './errors';
import type { Op, ParsedOp } from './schema';
import type { EditEnv, Origin, Sequence } from './types';

/** One undoable unit. A user gesture is one transaction; so is one whole agent turn. */
export interface Transaction {
  id: string;
  label: string;
  origin: Origin;
  ops: ParsedOp[];
  /** Applying to the state before the transaction yields the state after. */
  patches: Patch[];
  /** Applying to the state after the transaction restores the state before, exactly. */
  inverse: Patch[];
  /** Sequence revision after this transaction was applied. */
  revision: number;
  at: number;
  coalesceKey?: string;
  /** Transactions sharing a group (one agent run) can be undone and redone together. */
  group?: string;
}

export type EditorEvent =
  | { type: 'commit' | 'redo' | 'undo' | 'load'; revision: number; patches: Patch[]; transaction?: Transaction; state: Sequence };

export interface EditorOptions {
  maxHistory?: number;
  now?: () => number;
  /** Merge consecutive same-key single-op transactions made within this many ms (slider drags). */
  coalesceMs?: number;
}

interface OpenTx {
  group?: string;
  label: string;
  origin: Origin;
  startState: Sequence;
  ops: ParsedOp[];
  patches: Patch[];
  inverse: Patch[][];
}

/**
 * The transactional edit API. Everything — UI gestures, agent turns, plugins — goes through here, so every
 * change is validated, atomic, undoable and streamable as patches.
 */
export class Editor {
  private _state: Sequence;
  private workingState: Sequence;
  private _revision = 0;
  private txSeq = 0;
  private open: OpenTx | null = null;
  private readonly undoStack: Transaction[] = [];
  private readonly redoStack: Transaction[] = [];
  private readonly listeners = new Set<(e: EditorEvent) => void>();
  private readonly maxHistory: number;
  private readonly now: () => number;
  private readonly coalesceMs: number;

  constructor(
    seq: Sequence,
    readonly env: EditEnv,
    opts: EditorOptions = {},
  ) {
    // Immer deep-freezes whatever an edit produces. Doing it once here keeps that one-off cost (≈70 ms for 1,200
    // clips) out of the user's first edit.
    this._state = freeze(seq, true);
    this.workingState = this._state;
    this.maxHistory = opts.maxHistory ?? 500;
    this.now = opts.now ?? Date.now;
    this.coalesceMs = opts.coalesceMs ?? 0;
  }

  /** Committed state (not including an open transaction's pending edits — see `working`). */
  get state(): Sequence {
    return this._state;
  }

  /** State including the open transaction's edits so far. */
  get working(): Sequence {
    return this.open ? this.workingState : this._state;
  }

  get revision(): number {
    return this._revision;
  }
  get inTransaction(): boolean {
    return this.open !== null;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0 && !this.open;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0 && !this.open;
  }
  get history(): readonly Transaction[] {
    return this.undoStack;
  }
  get redoable(): readonly Transaction[] {
    return this.redoStack;
  }

  subscribe(fn: (e: EditorEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: EditorEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Replace the sequence and forget history (project load). */
  load(seq: Sequence): void {
    this._state = freeze(seq, true);
    this.workingState = this._state;
    this.open = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._revision++;
    this.emit({ type: 'load', revision: this._revision, patches: [], state: this._state });
  }

  begin(label: string, origin: Origin = 'user', group?: string): void {
    if (this.open) throw new EditError('invalid', 'A transaction is already open.');
    this.open = { label, origin, group, startState: this._state, ops: [], patches: [], inverse: [] };
    this.workingState = this._state;
  }

  /** Apply one operation. Inside a transaction it is staged; outside it commits as its own transaction. */
  apply(op: Op | ParsedOp, opts: { label?: string; origin?: Origin; coalesceKey?: string; group?: string } = {}): Transaction | null {
    if (!this.open) {
      this.begin(opts.label ?? defaultLabel(op), opts.origin ?? 'user', opts.group);
      try {
        this.stage(op);
      } catch (e) {
        this.rollback();
        throw e;
      }
      return this.commit(undefined, opts.coalesceKey);
    }
    this.stage(op);
    return null;
  }

  private stage(op: Op | ParsedOp): void {
    const tx = this.open!;
    const r = applyOp(this.workingState, op, this.env);
    tx.ops.push(r.op);
    tx.patches.push(...r.patches);
    tx.inverse.push(r.inverse);
    this.workingState = r.state;
  }

  /** Close the transaction. Returns null (and records nothing) if no operation changed anything. */
  commit(summary?: string, coalesceKey?: string): Transaction | null {
    const tx = this.open;
    if (!tx) throw new EditError('invalid', 'No transaction is open.');
    this.open = null;
    if (tx.patches.length === 0) {
      this.workingState = this._state;
      return null;
    }
    const record = this.record({ label: summary ?? tx.label, origin: tx.origin, group: tx.group, ops: tx.ops, patches: tx.patches, inverse: [...tx.inverse].reverse().flat(), state: this.workingState, coalesceKey });
    return record;
  }

  /** Push a finished transaction onto the undo stack (merging with the previous one when it is a drag of the same key). */
  private record(r: { label: string; origin: Origin; group?: string; ops: ParsedOp[]; patches: Patch[]; inverse: Patch[]; state: Sequence; coalesceKey?: string }): Transaction {
    const at = this.now();
    this._state = r.state;
    this.workingState = r.state;
    this.redoStack.length = 0;
    const last = this.undoStack[this.undoStack.length - 1];
    let record: Transaction;
    if (r.coalesceKey && last?.coalesceKey === r.coalesceKey && at - last.at <= this.coalesceMs) {
      last.ops.push(...r.ops);
      last.patches.push(...r.patches);
      last.inverse.unshift(...r.inverse);
      last.at = at;
      last.revision = ++this._revision;
      record = last;
    } else {
      record = {
        id: `tx${++this.txSeq}`,
        label: r.label,
        origin: r.origin,
        ops: r.ops,
        patches: r.patches,
        inverse: r.inverse,
        revision: ++this._revision,
        at,
        ...(r.group ? { group: r.group } : {}),
        ...(r.coalesceKey ? { coalesceKey: r.coalesceKey } : {}),
      };
      this.undoStack.push(record);
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    }
    this.emit({ type: 'commit', revision: this._revision, patches: r.patches, transaction: record, state: this._state });
    return record;
  }

  /**
   * Make the sequence equal `next` as a single undoable transaction (restoring a snapshot). The change is computed
   * as a diff, so it streams to clients as ordinary patches.
   */
  replaceState(next: Sequence, label: string, origin: Origin = 'user'): Transaction | null {
    if (this.open) throw new EditError('invalid', 'Commit or roll back the open transaction first.');
    const [state, patches, inverse] = produceWithPatches(this._state, (draft) => {
      for (const k of Object.keys(next) as (keyof Sequence)[]) (draft as Record<string, unknown>)[k] = next[k];
    });
    if (patches.length === 0) return null;
    return this.record({ label, origin, ops: [], patches, inverse, state });
  }

  /** Discard every staged edit of the open transaction. */
  rollback(): void {
    if (!this.open) return;
    this.open = null;
    this.workingState = this._state;
  }

  undo(): Transaction | null {
    if (this.open) throw new EditError('invalid', 'Commit or roll back the open transaction first.');
    const tx = this.undoStack.pop();
    if (!tx) return null;
    this._state = applyPatches(this._state, tx.inverse);
    this.workingState = this._state;
    this.redoStack.push(tx);
    this._revision++;
    this.emit({ type: 'undo', revision: this._revision, patches: tx.inverse, transaction: tx, state: this._state });
    return tx;
  }

  /** Undo every transaction of `group` at the top of the stack (one agent run). Returns how many were undone. */
  undoGroup(group: string): number {
    let n = 0;
    while (this.undoStack[this.undoStack.length - 1]?.group === group) {
      this.undo();
      n++;
    }
    return n;
  }

  /** Redo the transactions of `group` that sit at the top of the redo stack. */
  redoGroup(group: string): number {
    let n = 0;
    while (this.redoStack[this.redoStack.length - 1]?.group === group) {
      this.redo();
      n++;
    }
    return n;
  }

  redo(): Transaction | null {
    if (this.open) throw new EditError('invalid', 'Commit or roll back the open transaction first.');
    const tx = this.redoStack.pop();
    if (!tx) return null;
    this._state = applyPatches(this._state, tx.patches);
    this.workingState = this._state;
    this.undoStack.push(tx);
    this._revision++;
    this.emit({ type: 'redo', revision: this._revision, patches: tx.patches, transaction: tx, state: this._state });
    return tx;
  }
}

function defaultLabel(op: Op | ParsedOp): string {
  return op.type.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}
