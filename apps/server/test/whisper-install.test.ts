import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findWhisper } from '../src/analysis/whisper';
import { WhisperInstaller } from '../src/analysis/whisperInstall';

let dir: string;
let server: http.Server;
let base: string;
const hits: string[] = [];
let releaseOk = true;

const zip = zipSync({ 'Release/whisper-cli': new TextEncoder().encode('#!/bin/sh\necho fake\n'), 'Release/ggml.dll': new Uint8Array([1, 2, 3]) });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-whisper-'));
  hits.length = 0;
  releaseOk = true;
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/release') {
      if (!releaseOk) return void res.writeHead(500).end();
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tag_name: 'v9.9.9', assets: [{ name: 'whisper-bin-x64.zip', browser_download_url: `${base}/whisper-bin-x64.zip` }] }));
    }
    if (req.url === '/whisper-bin-x64.zip') return void res.writeHead(200, { 'content-length': zip.length }).end(Buffer.from(zip));
    if (req.url === '/ggml-base.bin') return void res.writeHead(200, { 'content-length': 2000 }).end(Buffer.alloc(2000, 7));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const until = async (inst: WhisperInstaller, ...states: string[]) => {
  for (let i = 0; i < 200 && !states.includes(inst.state().status); i++) await new Promise((r) => setTimeout(r, 25));
  return inst.state();
};

// PATH is emptied so a whisper.cpp on this machine cannot hide what the installer does
const make = (extra: Partial<ConstructorParameters<typeof WhisperInstaller>[0]> = {}) =>
  new WhisperInstaller({ dataDir: dir, platform: 'win32', arch: 'x64', env: { PATH: '' }, releaseApi: `${base}/release`, modelBase: base, ...extra });

describe('WhisperInstaller', () => {
  it('plans a download of both parts when nothing is installed', async () => {
    expect(await make().plan()).toEqual({ binary: 'download', model: true });
  });

  it('downloads whisper.cpp and the model, then they are found', async () => {
    let done = 0;
    const inst = make({ onInstalled: () => void done++ });
    expect(await findWhisper(dir, { PATH: '' })).toBeNull();
    inst.start('base');
    const s = await until(inst, 'done', 'error');
    expect(s).toMatchObject({ status: 'done', percent: 100 });
    const found = await findWhisper(dir, { PATH: '' });
    expect(found?.bin).toContain(path.join('whisper', 'Release', 'whisper-cli'));
    expect(path.basename(found!.model)).toBe('ggml-base.bin');
    expect((await fs.stat(found!.model)).size).toBe(2000);
    expect(done).toBe(1);
    expect(await make().plan()).toEqual({ binary: 'have', model: false });
    expect((await fs.readdir(path.join(dir, 'models'))).some((f) => f.endsWith('.partial'))).toBe(false);
  });

  it('only fetches what is missing', async () => {
    await fs.mkdir(path.join(dir, 'models'), { recursive: true });
    await fs.writeFile(path.join(dir, 'models', 'ggml-small.bin'), 'x');
    const inst = make();
    expect(await inst.plan()).toEqual({ binary: 'download', model: false });
    inst.start();
    await until(inst, 'done', 'error');
    expect(hits).not.toContain('/ggml-base.bin');
  });

  it('reports a failed lookup in plain words and leaves no partial files', async () => {
    releaseOk = false;
    const inst = make();
    inst.start();
    const s = await until(inst, 'done', 'error');
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/latest whisper\.cpp release/);
    expect(await fs.readdir(path.join(dir, 'whisper')).catch(() => [])).toEqual([]);
  });

  it('says what to do where it cannot install the program itself', async () => {
    const plan = await make({ platform: 'linux' }).plan();
    expect(plan.binary).toBe('unsupported');
    expect(plan.note).toMatch(/cmake/);
    const inst = make({ platform: 'linux' });
    inst.start();
    expect((await until(inst, 'error', 'done')).error).toMatch(/cmake/);
  });

  it('a model that is cut short is an error, not a corrupt file', async () => {
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url === '/release') return void res.writeHead(200).end(JSON.stringify({ tag_name: 'v1', assets: [{ name: 'whisper-bin-x64.zip', browser_download_url: `${base}/whisper-bin-x64.zip` }] }));
      if (req.url === '/whisper-bin-x64.zip') return void res.writeHead(200, { 'content-length': zip.length }).end(Buffer.from(zip));
      res.writeHead(200, { 'content-length': 5000 });
      res.write(Buffer.alloc(100));
      res.destroy();
    });
    const inst = make();
    inst.start();
    expect((await until(inst, 'error', 'done')).status).toBe('error');
    await expect(fs.access(path.join(dir, 'models', 'ggml-base.bin'))).rejects.toBeTruthy();
  });
});
