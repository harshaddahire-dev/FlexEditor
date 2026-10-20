import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzipSync } from 'fflate';
import { ProcessAbortedError, runText } from '../proc';
import { resolveInside } from '../security';
import { exists, renameRetry } from '../util';
import { findWhisperBin, findWhisperModel } from './whisper';

/** Models offered for one-click install (ggml, multilingual). Sizes are what the download is, roughly. */
export const WHISPER_MODELS = [
  { id: 'tiny', label: 'Tiny — fastest, rough', sizeMb: 75 },
  { id: 'base', label: 'Base — good balance (recommended)', sizeMb: 142 },
  { id: 'small', label: 'Small — most accurate, slower', sizeMb: 466 },
] as const;
export type WhisperModelId = (typeof WHISPER_MODELS)[number]['id'];

export type InstallStep = 'binary' | 'model';
export interface InstallState {
  status: 'idle' | 'running' | 'done' | 'error';
  step?: InstallStep;
  /** 0–100 for the current step. */
  percent: number;
  message: string;
  error?: string;
}

/** How whisper.cpp itself would be obtained on this machine. */
export type BinaryPlan = 'have' | 'download' | 'brew' | 'build' | 'unsupported';

export interface InstallerOptions {
  dataDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** Latest-release JSON of whisper.cpp (tests point this at a local server). */
  releaseApi?: string;
  /** Folder URL holding `ggml-<name>.bin` files. */
  modelBase?: string;
  /** Called after a successful install, e.g. to re-run transcripts that were waiting for it. */
  onInstalled?: () => void | Promise<void>;
}

// the newest releases often carry only source archives, so look through the recent ones for a build with Windows binaries
const RELEASE_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30';
/** Windows zips in order of preference: plain CPU, then OpenBLAS, then 32-bit (runs on 64-bit Windows). Never the CUDA ones. */
const WINDOWS_ASSETS = ['whisper-bin-x64.zip', 'whisper-blas-bin-x64.zip', 'whisper-bin-Win32.zip'];
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

interface Release {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  tarball_url?: string;
  assets?: { name: string; browser_download_url: string }[];
}

const onPath = async (name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | null> => {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, platform === 'win32' ? `${name}.exe` : name);
    if (await exists(p)) return p;
  }
  return null;
};

/**
 * One-click transcription setup: fetches whisper.cpp (a prebuilt release on Windows, Homebrew on macOS, a local build on Linux)
 * and a ggml model into the app's data folder. Only runs when the user asks for it.
 */
export class WhisperInstaller {
  private current: InstallState = { status: 'idle', percent: 0, message: '' };
  private abort: AbortController | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: InstallerOptions) {
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  get binDir(): string {
    return path.join(this.opts.dataDir, 'whisper');
  }
  get modelsDir(): string {
    return path.join(this.opts.dataDir, 'models');
  }

  state(): InstallState {
    return { ...this.current };
  }

  /** What an install would do right now. */
  async plan(): Promise<{ binary: BinaryPlan; model: boolean; note?: string }> {
    const bin = await findWhisperBin(this.opts.dataDir, this.env);
    const model = await findWhisperModel(this.opts.dataDir, this.env);
    let binary: BinaryPlan = 'have';
    let note: string | undefined;
    if (!bin) {
      if (this.platform === 'win32') binary = this.opts.arch === 'arm64' || (this.opts.arch ?? process.arch) === 'arm64' ? 'unsupported' : 'download';
      else if (this.platform === 'darwin') binary = (await onPath('brew', this.env, this.platform)) ? 'brew' : 'unsupported';
      else binary = (await onPath('cmake', this.env, this.platform)) && ((await onPath('g++', this.env, this.platform)) || (await onPath('c++', this.env, this.platform)) || (await onPath('clang++', this.env, this.platform))) ? 'build' : 'unsupported';
      if (binary === 'unsupported') {
        note =
          this.platform === 'darwin' ? 'Install Homebrew (brew.sh), or run: brew install whisper-cpp'
          : this.platform === 'linux' ? 'Needs cmake and a C++ compiler (sudo apt install cmake g++), or install whisper.cpp yourself and set WHISPER_CPP_BIN.'
          : 'No prebuilt whisper.cpp for this processor; build it yourself and set WHISPER_CPP_BIN.';
      }
    }
    return { binary, model: !model, ...(note ? { note } : {}) };
  }

  /** Begin installing (no-op while one is running). Returns at once; poll `state()`. */
  start(model: WhisperModelId = 'base'): InstallState {
    if (this.current.status === 'running') return this.state();
    if (!WHISPER_MODELS.some((m) => m.id === model)) model = 'base';
    this.abort = new AbortController();
    this.current = { status: 'running', percent: 0, message: 'Starting…' };
    void this.run(model, this.abort.signal);
    return this.state();
  }

  cancel(): void {
    this.abort?.abort();
  }

  private set(patch: Partial<InstallState>): void {
    this.current = { ...this.current, ...patch };
  }

  private async run(model: WhisperModelId, signal: AbortSignal): Promise<void> {
    try {
      const plan = await this.plan();
      if (plan.binary === 'unsupported') throw new Error(plan.note ?? 'whisper.cpp cannot be installed automatically on this machine.');
      if (plan.binary !== 'have') await this.installBinary(plan.binary, signal);
      if (plan.model) await this.installModel(model, signal);
      this.set({ status: 'done', step: undefined, percent: 100, message: 'Transcription is ready.' });
      await this.opts.onInstalled?.();
    } catch (e) {
      const cancelled = signal.aborted || e instanceof ProcessAbortedError;
      this.set(cancelled ? { status: 'idle', percent: 0, message: 'Cancelled.', step: undefined } : { status: 'error', error: e instanceof Error ? e.message : String(e), message: 'Could not install transcription.' });
    }
  }

  /* ---------- whisper.cpp itself ---------- */

  /** Recent releases, newest first (the API gives a list; a single release object is accepted too). */
  private async releases(signal: AbortSignal): Promise<Release[]> {
    const res = await this.fetchFn(this.opts.releaseApi ?? RELEASE_API, { headers: { 'user-agent': 'cutroom', accept: 'application/vnd.github+json' }, signal });
    if (!res.ok) throw new Error(`Could not look up whisper.cpp releases (HTTP ${res.status}). Check your internet connection.`);
    const json = (await res.json()) as Release | Release[];
    return (Array.isArray(json) ? json : [json]).filter((r) => !r.draft && !r.prerelease);
  }

  private async installBinary(plan: BinaryPlan, signal: AbortSignal): Promise<void> {
    this.set({ step: 'binary', percent: 0, message: 'Setting up whisper.cpp…' });
    if (plan === 'download') return this.downloadWindowsBinary(signal);
    if (plan === 'brew') {
      this.set({ message: 'Installing whisper.cpp with Homebrew…' });
      const r = await runText('brew', ['install', 'whisper-cpp'], { signal });
      if (r.code !== 0) throw new Error(`brew install whisper-cpp failed: ${r.stderr.trim().split('\n').pop() ?? ''}`);
      return;
    }
    return this.buildFromSource(signal);
  }

  private async downloadWindowsBinary(signal: AbortSignal): Promise<void> {
    const releases = await this.releases(signal);
    let rel: Release | undefined;
    let asset: { name: string; browser_download_url: string } | undefined;
    for (const r of releases) {
      for (const name of WINDOWS_ASSETS) {
        asset = r.assets?.find((a) => a.name === name);
        if (asset) break;
      }
      if (asset) {
        rel = r;
        break;
      }
    }
    if (!rel || !asset) throw new Error(`None of the last ${releases.length} whisper.cpp releases has a Windows download. Install whisper.cpp yourself and set WHISPER_CPP_BIN.`);
    await fs.mkdir(this.binDir, { recursive: true });
    const zip = path.join(this.binDir, 'download.zip.partial');
    this.set({ message: `Downloading whisper.cpp ${rel.tag_name}…` });
    await this.download(asset.browser_download_url, zip, signal);
    this.set({ message: 'Unpacking…', percent: 100 });
    const files = unzipSync(new Uint8Array(await fs.readFile(zip)));
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('/')) continue;
      const out = resolveInside(this.binDir, name); // refuses paths that climb out of the folder
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, data);
    }
    await fs.rm(zip, { force: true });
    if (!(await findWhisperBin(this.opts.dataDir, this.env))) throw new Error('The download did not contain whisper-cli.exe.');
  }

  private async buildFromSource(signal: AbortSignal): Promise<void> {
    const rel = (await this.releases(signal))[0];
    if (!rel?.tarball_url) throw new Error('The whisper.cpp release has no source download.');
    const work = path.join(this.binDir, 'src');
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { recursive: true });
    const tgz = path.join(this.binDir, 'source.tar.gz');
    this.set({ message: `Downloading whisper.cpp ${rel.tag_name} source…` });
    await this.download(rel.tarball_url, tgz, signal);
    this.set({ message: 'Unpacking…', percent: 100 });
    const x = await runText('tar', ['-xzf', tgz, '-C', work, '--strip-components=1'], { signal });
    if (x.code !== 0) throw new Error(`could not unpack the source: ${x.stderr.trim().split('\n').pop() ?? ''}`);
    this.set({ message: 'Building whisper.cpp (a few minutes)…', percent: 0 });
    const cfg = await runText('cmake', ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF'], { cwd: work, signal });
    if (cfg.code !== 0) throw new Error(`cmake failed: ${cfg.stderr.trim().split('\n').pop() ?? ''}`);
    const build = await runText('cmake', ['--build', 'build', '--config', 'Release', '-j', '--target', 'whisper-cli'], { cwd: work, signal });
    if (build.code !== 0) throw new Error(`the build failed: ${build.stderr.trim().split('\n').pop() ?? ''}`);
    const built = path.join(work, 'build', 'bin', 'whisper-cli');
    if (!(await exists(built))) throw new Error('The build did not produce whisper-cli.');
    const dest = path.join(this.binDir, 'bin');
    await fs.mkdir(dest, { recursive: true });
    await fs.copyFile(built, path.join(dest, 'whisper-cli'));
    await fs.chmod(path.join(dest, 'whisper-cli'), 0o755);
    await fs.rm(work, { recursive: true, force: true });
    await fs.rm(tgz, { force: true });
  }

  /* ---------- the model ---------- */

  private async installModel(model: WhisperModelId, signal: AbortSignal): Promise<void> {
    const info = WHISPER_MODELS.find((m) => m.id === model)!;
    this.set({ step: 'model', percent: 0, message: `Downloading the ${model} model (about ${info.sizeMb} MB)…` });
    await fs.mkdir(this.modelsDir, { recursive: true });
    const file = path.join(this.modelsDir, `ggml-${model}.bin`);
    const tmp = `${file}.partial`;
    await this.download(`${this.opts.modelBase ?? MODEL_BASE}/ggml-${model}.bin`, tmp, signal);
    await renameRetry(tmp, file);
  }

  /** Stream a URL to a file, reporting percent; the partial file is removed if anything goes wrong. */
  private async download(url: string, to: string, signal: AbortSignal): Promise<void> {
    try {
      const res = await this.fetchFn(url, { headers: { 'user-agent': 'cutroom' }, signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}) for ${new URL(url).host}. Check your internet connection.`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      const body = Readable.fromWeb(res.body as never);
      body.on('data', (c: Buffer) => {
        got += c.length;
        if (total) this.set({ percent: Math.min(99, Math.round((got / total) * 100)) });
      });
      await pipeline(body, createWriteStream(to), { signal });
      if (total && got !== total) throw new Error('The download ended early. Try again.');
    } catch (e) {
      await fs.rm(to, { force: true });
      throw e;
    }
  }
}
