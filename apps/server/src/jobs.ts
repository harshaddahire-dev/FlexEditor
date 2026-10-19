import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { JobInfo, JobKind } from '@cutroom/core';
import { ProcessAbortedError } from './proc';

export interface JobContext {
  signal: AbortSignal;
  /** Report progress in 0..1. */
  progress(fraction: number): void;
}

export interface JobSpec {
  kind: JobKind;
  label: string;
  mediaId?: string;
  run(ctx: JobContext): Promise<void>;
}

interface Entry {
  info: JobInfo;
  spec: JobSpec;
  abort: AbortController;
  done: Promise<void>;
  resolve: () => void;
}

/** Small FIFO queue with bounded concurrency, cancellation and progress events. */
export class JobQueue extends EventEmitter<{ update: [JobInfo] }> {
  private readonly entries = new Map<string, Entry>();
  private readonly pending: Entry[] = [];
  private running = 0;
  /** Finished jobs kept for the UI; older ones are dropped. */
  private static readonly HISTORY = 200;

  constructor(private readonly concurrency = 2) {
    super();
  }

  add(spec: JobSpec): JobInfo {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const entry: Entry = {
      info: { id: randomUUID(), kind: spec.kind, label: spec.label, mediaId: spec.mediaId, state: 'queued', progress: 0, createdAt: Date.now() },
      spec,
      abort: new AbortController(),
      done,
      resolve,
    };
    this.entries.set(entry.info.id, entry);
    this.pending.push(entry);
    this.emitUpdate(entry);
    queueMicrotask(() => this.pump());
    return { ...entry.info };
  }

  list(): JobInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  get(id: string): JobInfo | undefined {
    const e = this.entries.get(id);
    return e ? { ...e.info } : undefined;
  }

  cancel(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.info.state === 'done' || e.info.state === 'failed' || e.info.state === 'canceled') return false;
    e.abort.abort();
    if (e.info.state === 'queued') {
      const i = this.pending.indexOf(e);
      if (i >= 0) this.pending.splice(i, 1);
      this.finish(e, 'canceled');
    }
    return true;
  }

  cancelForMedia(mediaId: string): void {
    for (const e of this.entries.values()) if (e.info.mediaId === mediaId) this.cancel(e.info.id);
  }

  /** Resolves when every job queued so far has finished. */
  async idle(): Promise<void> {
    for (;;) {
      const live = [...this.entries.values()].filter((e) => e.info.state === 'queued' || e.info.state === 'running');
      if (!live.length) return;
      await Promise.all(live.map((e) => e.done));
    }
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length) {
      const e = this.pending.shift()!;
      if (e.abort.signal.aborted) continue;
      this.running++;
      void this.execute(e).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async execute(e: Entry): Promise<void> {
    e.info.state = 'running';
    e.info.startedAt = Date.now();
    this.emitUpdate(e);
    let lastEmit = 0;
    try {
      await e.spec.run({
        signal: e.abort.signal,
        progress: (f) => {
          const p = Math.max(0, Math.min(1, f));
          const now = Date.now();
          if (p >= 1 || now - lastEmit >= 100) {
            lastEmit = now;
            e.info.progress = p;
            this.emitUpdate(e);
          }
        },
      });
      e.info.progress = 1;
      this.finish(e, 'done');
    } catch (err) {
      if (err instanceof ProcessAbortedError || e.abort.signal.aborted) this.finish(e, 'canceled');
      else {
        e.info.error = err instanceof Error ? err.message : String(err);
        this.finish(e, 'failed');
      }
    }
  }

  private finish(e: Entry, state: 'done' | 'failed' | 'canceled'): void {
    e.info.state = state;
    e.info.finishedAt = Date.now();
    this.emitUpdate(e);
    e.resolve();
    this.trimHistory();
  }

  private trimHistory(): void {
    const finished = [...this.entries.values()].filter((x) => x.info.finishedAt);
    for (const e of finished.slice(0, Math.max(0, finished.length - JobQueue.HISTORY))) this.entries.delete(e.info.id);
  }

  private emitUpdate(e: Entry): void {
    this.emit('update', { ...e.info });
  }
}
