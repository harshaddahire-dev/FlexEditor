'use strict';
/**
 * Cutroom desktop shell. It starts the Cutroom server inside this process (on a free local port, with the bundled FFmpeg
 * and the app's own data folder), opens a window on it, and stops it again on quit. Nothing to install or run by hand.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, shell } = require('electron');
const { createUpdater } = require('./updater.cjs');

const SMOKE = process.env.CUTROOM_SMOKE === '1';
const HOME_PAGE = 'https://github.com/harshaddahire-dev/FlexEditor';
const RELEASES_PAGE = HOME_PAGE + '/releases/latest';
let server = null;
let updater = null;
let win = null;
let quitting = false;

app.setAppUserModelId('app.cutroom.editor');

// Everything the server prints (probe, proxy and render failures included) goes to a log file as well, so a problem can be read
// afterwards: Help → Show log file.
const logFile = path.join(app.getPath('userData'), 'logs', 'cutroom.log');
try {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, logFile + '.old');
} catch {
  /* logging must never stop the app */
}
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
    } catch {
      /* ignore */
    }
  };
}
process.on('uncaughtException', (e) => console.error('uncaught', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));

// the compositor needs WebGL2: when a machine's GPU or driver is blocklisted, fall back to software rendering instead of failing
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

function bundled(pkg, pick) {
  try {
    const p = pick(require(pkg));
    return p && fs.existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Skills and plugins sit next to the app when installed, and in the repo layout when run from source. */
function extensionsRoot() {
  const installed = process.resourcesPath;
  return app.isPackaged && fs.existsSync(path.join(installed, 'skills')) ? installed : __dirname;
}

async function startServer() {
  const entry = pathToFileURL(path.join(__dirname, 'server', 'start.js')).href;
  const { startServer: start } = await import(entry);
  // an FFmpeg of the user's own (FFMPEG_PATH) wins; otherwise the one that ships with the app
  const ffmpegPath = process.env.FFMPEG_PATH || bundled('ffmpeg-static', (m) => m) || 'ffmpeg';
  const ffprobePath = process.env.FFPROBE_PATH || bundled('ffprobe-static', (m) => m.path) || 'ffprobe';
  return start({
    host: '127.0.0.1',
    port: 0,
    dataDir: process.env.CUTROOM_DATA_DIR || path.join(app.getPath('userData'), 'data'),
    webDist: path.join(__dirname, 'web'),
    extensionsRoot: extensionsRoot(),
    ffmpegPath,
    ffprobePath,
  });
}

/**
 * Updates come from this repo's GitHub releases. Windows (installed) and Linux (AppImage) update themselves in place; macOS builds
 * are not signed, which the OS requires for in-place updates, so there the app says so and opens the download page.
 */
function setupUpdater() {
  let autoUpdater = null;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.warn('auto-update is not available:', e && e.message);
    return null;
  }
  const feed = process.env.CUTROOM_UPDATE_URL; // test hook: a local folder served over http
  if (feed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    autoUpdater.forceDevUpdateConfig = true;
  }
  const selfUpdating = process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE);
  const canInstall = (app.isPackaged || !!feed) && selfUpdating && !process.env.CUTROOM_UPDATE_NO_DOWNLOAD;
  return createUpdater({
    currentVersion: process.env.CUTROOM_FAKE_VERSION || app.getVersion(),
    autoUpdater,
    shell,
    settingsFile: path.join(app.getPath('userData'), 'settings.json'),
    releaseUrl: RELEASES_PAGE,
    canInstall,
    emit: (state) => {
      if (win && !win.isDestroyed()) win.webContents.send('cutroom:update-state', state);
    },
    log: (level, message) => console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']('[update]', message),
  });
}

/** Is anything running that a restart would cut short: a render, an analysis job, an agent run? */
async function workInProgress() {
  if (!server) return false;
  const get = (p) => fetch(server.url + p).then((r) => r.json()).catch(() => null);
  const [jobs, chat] = await Promise.all([get('/api/jobs'), get('/api/agent/chat')]);
  return (Array.isArray(jobs) && jobs.some((j) => j.state === 'queued' || j.state === 'running')) || !!(chat && chat.activeRunId);
}

/**
 * Help → Copy diagnostics: everything needed to see why the picture is black or a stage is stuck, as text to paste —
 * versions, graphics (WebGL renderer, GPU status), which codecs this machine can decode, the media and its stages, jobs,
 * what the monitor says, and the end of the log. No file contents, no keys.
 */
async function copyDiagnostics() {
  const lines = [`Cutroom ${app.getVersion()} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · ${process.platform} ${process.arch}`];
  const get = (p) => fetch(server.url + p).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  try {
    lines.push('GPU status: ' + JSON.stringify(app.getGPUFeatureStatus()));
    const gpu = await app.getGPUInfo('basic').catch(() => null);
    if (gpu && gpu.gpuDevice) lines.push('GPU devices: ' + gpu.gpuDevice.map((d) => `${d.vendorId}:${d.deviceId}${d.active ? '*' : ''} ${d.driverVersion || ''}`).join(', '));
  } catch {
    /* ignore */
  }
  if (win && !win.isDestroyed()) {
    const page = await win.webContents
      .executeJavaScript(`(async () => {
        const out = {};
        try { const gl = document.createElement('canvas').getContext('webgl2'); const ext = gl && gl.getExtension('WEBGL_debug_renderer_info'); out.webgl2 = gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'yes') : 'NOT AVAILABLE'; } catch (e) { out.webgl2 = 'error ' + e; }
        const codecs = { h264: 'avc1.640028', h264_444: 'avc1.F4001F', hevc: 'hvc1.1.6.L93.B0', vp9: 'vp09.00.10.08', av1: 'av01.0.05M.08' };
        out.decode = {};
        for (const [k, c] of Object.entries(codecs)) { try { out.decode[k] = (await VideoDecoder.isConfigSupported({ codec: c, codedWidth: 1920, codedHeight: 1080 })).supported; } catch (e) { out.decode[k] = 'error'; } }
        out.monitorNote = (document.querySelector('[data-testid="program-monitor"] .viewer__note') || {}).innerText || null;
        const c = document.querySelector('.viewer__host canvas'); out.canvas = c ? c.width + 'x' + c.height : null;
        return out;
      })()`)
      .catch((e) => ({ error: String(e) }));
    lines.push('Page: ' + JSON.stringify(page));
  }
  const health = await get('/api/health');
  lines.push('FFmpeg: ' + JSON.stringify({ ok: health.ffmpeg && health.ffmpeg.ok, version: health.ffmpeg && health.ffmpeg.ffmpeg && health.ffmpeg.ffmpeg.version, problems: health.ffmpeg && health.ffmpeg.problems, whisper: health.whisper && health.whisper.available }));
  const proj = await get('/api/project');
  const media = (proj.project && proj.project.media) || [];
  for (const m of media) {
    const v = m.video;
    lines.push(`Media ${m.name}: ${m.type} ${Math.round(Number(m.sizeBytes) / 1e6)} MB, ${v ? `${v.codec} ${v.profile || ''} ${v.pixFmt || ''} ${v.width}x${v.height}${v.hdr ? ' HDR' : ''}${v.vfr ? ' VFR' : ''}` : 'no video'}; status ${JSON.stringify(m.status)}; proxy ${m.proxy ? `${m.proxy.codec} ${m.proxy.width}x${m.proxy.height}` : 'none'}; warnings ${JSON.stringify(m.warnings)}`);
  }
  const seq = proj.project && proj.project.sequences && proj.project.sequences[0];
  if (seq) {
    lines.push(`Sequence: ${seq.width}x${seq.height} @ ${seq.timebase && seq.timebase.rate} ticks/s`);
    for (const t of seq.tracks) {
      const items = Object.values(t.items || {}).slice(0, 4).map((c) => `${c.kind}${c.mediaId ? ' ' + c.mediaId : ''} start=${c.start} dur=${c.duration}${c.sourceIn !== undefined ? ' in=' + c.sourceIn : ''}${c.speed ? ' speed=' + JSON.stringify(c.speed) : ''}${c.transform ? ' opacity=' + c.transform.opacity + ' scale=' + JSON.stringify(c.transform.scale) + ' pos=' + JSON.stringify(c.transform.position) + ' crop=' + JSON.stringify(c.transform.crop) : ''}`);
      lines.push(`  ${t.kind} ${t.name}${t.muted ? ' (muted/hidden)' : ''}${t.locked ? ' (locked)' : ''}: ${Object.keys(t.items || {}).length} items; ${items.join(' | ')}`);
    }
  }
  const jobs = await get('/api/jobs');
  if (Array.isArray(jobs)) lines.push('Jobs: ' + jobs.slice(-8).map((j) => `${j.kind}/${j.state}/${Math.round(j.progress * 100)}%${j.error ? ' ' + j.error : ''}`).join('; '));
  try {
    lines.push('--- log (last 60 lines) ---', ...fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-60));
  } catch {
    /* no log */
  }
  clipboard.writeText(lines.join('\n'));
  await dialog.showMessageBox(win ?? undefined, { type: 'info', message: 'Diagnostics copied', detail: 'Paste them into your message to the developer (Ctrl+V). They contain no keys and none of your footage.', buttons: ['OK'] });
}

/** Help → Check for updates…, with a native answer. */
async function checkFromMenu() {
  if (!updater) return void dialog.showMessageBox(win ?? undefined, { type: 'info', message: 'Updates are not available in this build.', buttons: ['OK'] });
  const s = await updater.check({ manual: true });
  const parent = win ?? undefined;
  if (s.status === 'error') return void dialog.showMessageBox(parent, { type: 'warning', message: 'Could not check for updates', detail: s.error ?? '', buttons: ['OK'] });
  if (s.status === 'uptodate' || s.status === 'idle') return void dialog.showMessageBox(parent, { type: 'info', message: `Cutroom ${s.current} is up to date.`, buttons: ['OK'] });
  if (s.status === 'ready') {
    const r = await dialog.showMessageBox(parent, { type: 'question', message: `Cutroom ${s.latest} is ready`, detail: 'Restart now to finish updating? Your project is saved automatically.', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1 });
    if (r.response === 0) await installNow(true);
  } else if (!s.canInstall) {
    const r = await dialog.showMessageBox(parent, { type: 'info', message: `Cutroom ${s.latest} is available`, detail: 'This build cannot update itself. Download the new version from the releases page.', buttons: ['Open download page', 'Later'], defaultId: 0, cancelId: 1 });
    if (r.response === 0) await updater.download();
  } else {
    await dialog.showMessageBox(parent, { type: 'info', message: `Downloading Cutroom ${s.latest}…`, detail: 'It installs when you restart. You can keep working.', buttons: ['OK'] });
  }
}

async function installNow(force) {
  // quitAndInstall quits the app; before-quit below lets the server save first, then quits again so the installer step runs
  return updater.install({ busy: workInProgress, force });
}

function menu() {
  const mac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [mac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }])],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Check for updates…', click: () => void checkFromMenu() },
        { label: 'Cutroom on GitHub', click: () => void shell.openExternal(HOME_PAGE) },
        { label: 'Copy diagnostics', click: () => void copyDiagnostics() },
        { label: 'Show log file', click: () => void shell.showItemInFolder(logFile) },
        { label: 'Show app data folder', click: () => void shell.openPath(app.getPath('userData')) },
      ],
    },
  ]);
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    title: 'Cutroom',
    backgroundColor: '#111112',
    autoHideMenuBar: false, // Help (diagnostics, log, updates) should be easy to find
    icon: fs.existsSync(path.join(__dirname, 'icon.png')) ? path.join(__dirname, 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // playback and the audio clock must keep running when the window is behind another one
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => win.show());
  // only the local server is ever shown in the window; links go to the system browser
  const local = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin !== local) {
      e.preventDefault();
      if (/^https?:/i.test(target)) void shell.openExternal(target);
    }
  });
  win.on('closed', () => (win = null));
  return win.loadURL(url);
}

ipcMain.handle('cutroom:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win ?? undefined, { title: 'Choose a folder of footage', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});
ipcMain.handle('cutroom:reveal', (_e, target) => {
  if (typeof target === 'string' && path.isAbsolute(target) && fs.existsSync(target)) shell.showItemInFolder(target);
});

ipcMain.handle('cutroom:diagnostics', () => copyDiagnostics());
ipcMain.handle('cutroom:update-get', () => (updater ? updater.state() : null));
ipcMain.handle('cutroom:update-check', () => (updater ? updater.check({ manual: true }) : null));
ipcMain.handle('cutroom:update-download', () => updater && updater.download());
ipcMain.handle('cutroom:update-install', (_e, force) => (updater ? installNow(force === true) : { ok: false, reason: 'unavailable' }));
ipcMain.handle('cutroom:update-set-auto', (_e, on) => updater && updater.setAuto(on === true));

async function smoke() {
  // a self-test used by CI and by `pnpm desktop:smoke`: prove the window, the server, FFmpeg and the bridge all came up
  await new Promise((r) => setTimeout(r, 2500));
  const info = await win.webContents.executeJavaScript(`(async () => {
    const h = await fetch('/api/health').then((r) => r.json());
    const dec = typeof VideoDecoder !== 'undefined' ? (await VideoDecoder.isConfigSupported({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 })).supported : false;
    const enc = typeof VideoEncoder !== 'undefined' ? (await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8e6, framerate: 30, avc: { format: 'annexb' } }).catch(() => ({ supported: false }))).supported : false;
    return { title: document.title, hasBridge: !!window.cutroomDesktop, h264Decode: dec, h264Encode: enc, text: document.body.innerText.slice(0, 200).replace(/\\s+/g, ' '), api: { ok: h.ffmpeg.ok, problems: h.ffmpeg.problems, ffmpeg: h.ffmpeg.ffmpeg ? h.ffmpeg.ffmpeg.version : null, dataDir: h.dataDir } };
  })()`);
  const out = process.env.CUTROOM_SMOKE_OUT;
  if (out) fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
  console.log('SMOKE ' + JSON.stringify({ url: server.url, ...info }));
  quitting = true;
  await server.close().catch(() => undefined);
  app.exit(info.api.ok && info.hasBridge ? 0 : 1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(menu());
    try {
      server = await startServer();
    } catch (e) {
      dialog.showErrorBox('Cutroom could not start', String((e && e.stack) || e));
      app.exit(1);
      return;
    }
    console.info(`Cutroom ${server.version} on ${server.url}; FFmpeg ${server.ffmpeg.ok ? server.ffmpeg.version : 'NOT READY'}; ${process.platform} ${process.arch}`);
    if (!server.ffmpeg.ok) console.warn('FFmpeg is not ready:', server.ffmpeg.problems.join(' '));
    updater = SMOKE ? null : setupUpdater();
    await createWindow(server.url);
    if (updater) updater.start();
    if (SMOKE) await smoke();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (quitting || !server) return;
    // let the server save the project and stop its jobs first
    e.preventDefault();
    quitting = true;
    server.close().catch(() => undefined).finally(() => app.quit());
  });
  app.on('activate', () => {
    if (!win && server) void createWindow(server.url);
  });
}
