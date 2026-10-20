// node --test desktop/test/updater.test.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const { createUpdater } = createRequire(import.meta.url)('../updater.cjs');

function rig({ canInstall = true, autoUpdate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-upd-'));
  const settingsFile = path.join(dir, 'settings.json');
  if (autoUpdate !== undefined) fs.writeFileSync(settingsFile, JSON.stringify({ autoUpdate }));
  const au = Object.assign(new EventEmitter(), {
    calls: [],
    nextCheck: 'available',
    async checkForUpdates() {
      this.calls.push('check');
      this.emit('checking-for-update');
      if (this.nextCheck === 'available') this.emit('update-available', { version: '2.0.0', releaseNotes: '<p>Faster <b>exports</b></p>' });
      else if (this.nextCheck === 'none') this.emit('update-not-available', { version: '1.0.0' });
      else {
        this.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\nstack…'));
        throw new Error('offline');
      }
    },
    async downloadUpdate() {
      this.calls.push('download');
      this.emit('download-progress', { percent: 40.4, bytesPerSecond: 1000 });
      this.emit('download-progress', { percent: 100, bytesPerSecond: 1000 });
      this.emit('update-downloaded', { version: '2.0.0' });
    },
    quitAndInstall(...args) {
      this.calls.push(['install', ...args]);
    },
  });
  const events = [];
  const opened = [];
  const timers = [];
  const u = createUpdater({
    currentVersion: '1.0.0',
    autoUpdater: au,
    shell: { openExternal: async (url) => opened.push(url) },
    settingsFile,
    releaseUrl: 'https://example.com/releases',
    canInstall,
    emit: (s) => events.push(s.status),
    setTimeoutFn: (fn, ms) => (timers.push({ fn, ms }), { unref() {} }),
    setIntervalFn: (fn, ms) => (timers.push({ fn, ms, every: true }), { unref() {} }),
    now: () => 1234,
  });
  return { u, au, events, opened, timers, settingsFile };
}

test('finds an update, downloads it in the background, and is ready to install', async () => {
  const { u, au, events } = rig();
  await u.check();
  assert.deepEqual(events, ['checking', 'available', 'downloading', 'downloading', 'downloading', 'ready']);
  const s = u.state();
  assert.equal(s.status, 'ready');
  assert.equal(s.latest, '2.0.0');
  assert.equal(s.notes, 'Faster exports'); // markup stripped
  assert.deepEqual(au.calls, ['check', 'download']);
});

test('install waits for the user: refuses while work is running, goes when it is not or when forced', async () => {
  const { u, au } = rig();
  await u.check();
  assert.deepEqual(await u.install({ busy: async () => true }), { ok: false, reason: 'busy' });
  assert.equal(au.calls.some((c) => Array.isArray(c)), false);
  assert.deepEqual(await u.install({ busy: async () => false }), { ok: true });
  assert.deepEqual(au.calls.at(-1), ['install', false, true]); // not silent, relaunch after installing
  const again = rig();
  await again.u.check();
  assert.deepEqual(await again.u.install({ busy: async () => true, force: true }), { ok: true });
});

test('install does nothing before an update has been downloaded', async () => {
  const { u } = rig();
  assert.deepEqual(await u.install(), { ok: false, reason: 'not-ready' });
});

test('with automatic updates off it only announces, and downloads when asked or when turned back on', async () => {
  const { u, au, settingsFile } = rig({ autoUpdate: false });
  assert.equal(u.state().auto, false);
  await u.check({ manual: true });
  assert.equal(u.state().status, 'available');
  assert.deepEqual(au.calls, ['check']);
  await u.download();
  assert.equal(u.state().status, 'ready');

  const second = rig({ autoUpdate: false });
  await second.u.check();
  assert.equal(second.u.state().status, 'available');
  second.u.setAuto(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(second.u.state().status, 'ready');
  assert.equal(JSON.parse(fs.readFileSync(second.settingsFile, 'utf8')).autoUpdate, true);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).autoUpdate, false);
});

test('builds that cannot update themselves (macOS, plain Linux binaries) point to the release page instead', async () => {
  const { u, au, opened } = rig({ canInstall: false });
  await u.check();
  assert.equal(u.state().status, 'available');
  assert.equal(u.state().canInstall, false);
  assert.deepEqual(au.calls, ['check']); // never tries to download
  await u.download();
  assert.deepEqual(opened, ['https://example.com/releases']);
  assert.deepEqual(await u.install(), { ok: false, reason: 'not-ready' });
});

test('"up to date" is reported, and a failed background check stays quiet while a manual one says why', async () => {
  const quiet = rig();
  quiet.au.nextCheck = 'none';
  await quiet.u.check({ manual: true });
  assert.equal(quiet.u.state().status, 'uptodate');
  assert.equal(quiet.u.state().lastChecked, 1234);

  const background = rig();
  background.au.nextCheck = 'fail';
  await background.u.check();
  assert.equal(background.u.state().status, 'idle');
  assert.equal(background.u.state().error, null);

  const asked = rig();
  asked.au.nextCheck = 'fail';
  await asked.u.check({ manual: true });
  assert.equal(asked.u.state().status, 'error');
  assert.equal(asked.u.state().error, 'net::ERR_INTERNET_DISCONNECTED'); // first line only
});

test('checks once shortly after start, then every few hours, only while automatic', async () => {
  const { u, au, timers } = rig();
  u.start();
  u.start(); // idempotent
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms <= 30_000);
  timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(au.calls.slice(0, 1), ['check']);
  const every = timers.find((t) => t.every);
  assert.ok(every && every.ms >= 3600_000);

  const off = rig({ autoUpdate: false });
  off.u.start();
  off.timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(off.au.calls, []);
});

test('never checks again while a download is running or an update is waiting to install', async () => {
  const { u, au } = rig();
  await u.check();
  au.calls.length = 0;
  await u.check();
  assert.deepEqual(au.calls, []);
});
