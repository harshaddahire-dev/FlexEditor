import { spawn } from 'node:child_process';

export interface RunOptions {
  signal?: AbortSignal;
  /** Called for every complete stdout line (text mode only). */
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  cwd?: string;
}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export class ProcessAbortedError extends Error {
  constructor() {
    super('process aborted');
    this.name = 'ProcessAbortedError';
  }
}

function lineSplitter(cb?: (line: string) => void) {
  let rest = '';
  return {
    push(chunk: Buffer) {
      if (!cb) return;
      rest += chunk.toString('utf8');
      let i: number;
      while ((i = rest.search(/\r?\n/)) >= 0) {
        cb(rest.slice(0, i));
        rest = rest.slice(rest[i] === '\r' ? i + 2 : i + 1);
      }
    },
    flush() {
      if (cb && rest) cb(rest);
      rest = '';
    },
  };
}

/** Spawn without a shell; collects stdout as a Buffer (so PCM/raw frames survive intact). */
export function runBinary(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new ProcessAbortedError());
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd, windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    const outLines = lineSplitter(opts.onStdoutLine);
    const errLines = lineSplitter(opts.onStderrLine);
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => {
      out.push(c);
      outLines.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
      if (err.length > 256_000) err = err.slice(-128_000); // keep the tail only
      errLines.push(c);
    });
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      outLines.flush();
      errLines.flush();
      if (aborted) return reject(new ProcessAbortedError());
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

export async function runText(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runBinary(cmd, args, opts);
  return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr };
}
