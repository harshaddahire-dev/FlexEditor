'use strict';
/**
 * Cutroom's update controller. It owns *what the user sees and when*; electron-updater (injected, so this file is testable
 * without Electron) does the downloading and installing.
 *
 *  - checks shortly after start and every few hours, quietly; offline is not an error worth showing
 *  - downloads in the background (differentially on Windows) and installs when the app quits, or on "Restart to update"
 *  - never installs under the user's feet: install() asks the caller whether work is running first
 *  - where it cannot install by itself (macOS builds are not signed; a Linux binary that is not an AppImage) it says
 *    "update available" and sends the user to the release page instead of pretending
 *  - the user can turn automatic downloads off; a manual "Check now" always works
 */
const fs = require('node:fs');
const path = require('node:path');

const HOURS = 3600_000;
const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 4 * HOURS;

/** @typedef {'idle'|'checking'|'available'|'downloading'|'ready'|'uptodate'|'error'} Status */

function createUpdater({ currentVersion, autoUpdater, shell, settingsFile, releaseUrl, canInstall, emit = () => {}, log = () => {}, setTimeoutFn = setTimeout, setIntervalFn = setInterval, now = () => Date.now() }) {
  let auto = true;
  try {
    auto = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).autoUpdate !== false;
  } catch {
    /* first run: automatic */
  }

  /** @type {{status: Status, current: string, latest: string|null, percent: number, notes: string|null, error: string|null, lastChecked: number|null, auto: boolean, canInstall: boolean, releaseUrl: string, bytesPerSecond: number}} */
  const state = { status: 'idle', current: currentVersion, latest: null, percent: 0, notes: null, error: null, lastChecked: null, auto, canInstall, releaseUrl, bytesPerSecond: 0 };
  let timer = null;
  let manual = false;

  const set = (patch) => {
    Object.assign(state, patch);
    emit({ ...state });
  };

  autoUpdater.autoDownload = false; // we start downloads ourselves, so the setting is honoured
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m), debug: () => {} };

  const notesOf = (info) => {
    const n = info && info.releaseNotes;
    if (typeof n === 'string') return n.replace(/<[^>]+>/g, '').trim().slice(0, 1500) || null;
    if (Array.isArray(n)) return n.map((x) => x.note).join('\n').replace(/<[^>]+>/g, '').trim().slice(0, 1500) || null;
    return null;
  };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => {
    set({ status: 'available', latest: info.version, notes: notesOf(info), percent: 0, lastChecked: now() });
    if (state.canInstall && state.auto) void download();
  });
  autoUpdater.on('update-not-available', () => set({ status: 'uptodate', latest: currentVersion, lastChecked: now() }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent), bytesPerSecond: Math.round(p.bytesPerSecond || 0) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', latest: info.version, percent: 100, notes: notesOf(info) ?? state.notes }));
  autoUpdater.on('error', (e) => {
    const message = String((e && e.message) || e).split('\n')[0].slice(0, 300);
    log('error', `update: ${message}`);
    // a failed background check (offline, rate limit) is not worth a message; one the user asked for is
    set({ status: manual || state.status === 'downloading' ? 'error' : state.latest && state.status === 'available' ? 'available' : 'idle', error: manual || state.status === 'downloading' ? message : null, lastChecked: now() });
  });

  async function download() {
    if (!state.canInstall || state.status === 'downloading' || state.status === 'ready') return;
    set({ status: 'downloading', percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      /* the 'error' event has told the user */
      log('error', `update download: ${e && e.message}`);
    }
  }

  async function check({ manual: isManual = false } = {}) {
    if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state;
    manual = isManual;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      if (isManual && state.status !== 'error') set({ status: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 300), lastChecked: now() });
    }
    return { ...state };
  }

  return {
    state: () => ({ ...state }),

    /** Begin the schedule (call once the window is up). */
    start() {
      if (timer) return;
      timer = setTimeoutFn(() => {
        if (state.auto) void check();
        timer = setIntervalFn(() => state.auto && void check(), EVERY_MS);
      }, FIRST_CHECK_MS);
      if (timer && timer.unref) timer.unref();
    },

    check,

    /** "Download" for builds that cannot self-update, or after the user turned automatic downloads off. */
    async download() {
      if (state.canInstall) return download();
      if (shell) await shell.openExternal(state.releaseUrl);
    },

    /**
     * Restart into the new version. `busy()` says whether something the user would lose is running (a render, an agent run);
     * the caller decides what to do about it, here we just refuse until it says go.
     */
    async install({ busy = async () => false, force = false } = {}) {
      if (state.status !== 'ready') return { ok: false, reason: 'not-ready' };
      if (!force && (await busy())) return { ok: false, reason: 'busy' };
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    },

    setAuto(value) {
      auto = !!value;
      set({ auto });
      try {
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.writeFileSync(settingsFile, JSON.stringify({ autoUpdate: auto }));
      } catch {
        /* a read-only profile still works for this session */
      }
      // turning it on picks up an update that was found while it was off
      if (auto && state.status === 'available' && state.canInstall) void download();
    },
  };
}

module.exports = { createUpdater, EVERY_MS, FIRST_CHECK_MS };
