#!/usr/bin/env node
/**
 * Build the Cutroom desktop app.
 *
 *   node desktop/build.mjs stage        build web + server and assemble desktop/app (a runnable Electron app)
 *   node desktop/build.mjs dist [--win|--mac|--linux]   …and make the installer in ./release for this OS (or the flag's)
 *   node desktop/build.mjs smoke        …and start it headless to prove window, server, FFmpeg and bridge all work (Linux: needs xvfb)
 *   node desktop/build.mjs run          …and open it
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const app = path.join(here, 'app');
const [mode = 'stage', ...flags] = process.argv.slice(2);
const win = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: win, cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env } });
  if (r.status !== 0) {
    console.error(`\nFailed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

const TARGETS = { '--win': 'win32', '--mac': 'darwin', '--linux': 'linux' };
const targetPlatform = flags.map((f) => TARGETS[f]).find(Boolean) ?? process.platform;
const crossBuild = targetPlatform !== process.platform;

function stage() {
  run('pnpm', ['--filter', '@cutroom/web', 'build']);
  run('pnpm', ['--filter', '@cutroom/server', 'build']);

  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  for (const f of ['main.cjs', 'preload.cjs', 'updater.cjs']) fs.copyFileSync(path.join(here, f), path.join(app, f));
  fs.copyFileSync(path.join(here, 'build', 'icon.png'), path.join(app, 'icon.png'));
  fs.cpSync(path.join(root, 'apps/web/dist'), path.join(app, 'web'), { recursive: true });
  fs.mkdirSync(path.join(app, 'server'));
  for (const f of fs.readdirSync(path.join(root, 'apps/server/dist'))) if (f.endsWith('.js')) fs.copyFileSync(path.join(root, 'apps/server/dist', f), path.join(app, 'server', f));
  // tsup writes ESM; the app folder has its own package.json, so say so for the server folder
  fs.writeFileSync(path.join(app, 'server', 'package.json'), JSON.stringify({ type: 'module' }));
  fs.cpSync(path.join(root, 'skills'), path.join(app, 'skills'), { recursive: true });
  fs.cpSync(path.join(root, 'plugins'), path.join(app, 'plugins'), { recursive: true });

  // the server's own runtime dependencies (everything else is bundled into server/*.js), plus the FFmpeg binaries
  const srv = JSON.parse(fs.readFileSync(path.join(root, 'apps/server/package.json'), 'utf8'));
  const deps = Object.fromEntries(Object.entries(srv.dependencies).filter(([k]) => !k.startsWith('@cutroom/')));
  const top = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
  // CI sets CUTROOM_VERSION so every build is newer than the last one (that is what lets installed apps see an update)
  const version = (process.env.CUTROOM_VERSION || top.version).replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error(`CUTROOM_VERSION "${version}" is not a version like 1.2.3`);
    process.exit(2);
  }
  console.log(`Cutroom version ${version}`);
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify({ name: 'cutroom', productName: 'Cutroom', version, description: 'Local-first video editor where AI agents do the cutting.', author: 'Cutroom', license: 'MIT', main: 'main.cjs', dependencies: { ...deps, 'electron-updater': '^6.8.9', 'ffmpeg-static': '^5.2.0', 'ffprobe-static': '^3.1.0' } }, null, 2),
  );
  // ffmpeg-static downloads the binary of the platform npm runs on; ask for the target's when cross-building
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app, env: crossBuild ? { npm_config_platform: targetPlatform, npm_config_arch: 'x64' } : {} });
  if (crossBuild) console.log(`! cross-building for ${targetPlatform}: the bundled FFmpeg cannot be checked here (build on that OS for the full check)`);
  else checkFfmpeg();
}

/** The editor needs a handful of filters and encoders; fail the build rather than ship an app that cannot export. */
function checkFfmpeg() {
  const bin = fs.existsSync(path.join(app, 'node_modules/ffmpeg-static')) ? path.join(app, 'node_modules/ffmpeg-static', win ? 'ffmpeg.exe' : 'ffmpeg') : null;
  if (!bin || !fs.existsSync(bin)) return console.warn('! bundled ffmpeg not found for this platform (it is downloaded at install time)');
  const out = (a) => spawnSync(bin, ['-hide_banner', ...a], { encoding: 'utf8' }).stdout ?? '';
  const filters = out(['-filters']);
  const encoders = out(['-encoders']);
  const need = ['silencedetect', 'ebur128', 'xfade', 'ass', 'gblur', 'unsharp'].filter((f) => !new RegExp(`\\s${f}\\s`).test(filters));
  const needEnc = ['libx264', 'prores_ks', 'libvpx-vp9', 'aac'].filter((e) => !new RegExp(`\\s${e}\\s`).test(encoders));
  if (need.length || needEnc.length) {
    console.error(`Bundled FFmpeg is missing: ${[...need, ...needEnc].join(', ')}`);
    process.exit(1);
  }
  console.log('✓ bundled FFmpeg has every filter and encoder Cutroom needs');
}

function builder(extra = []) {
  if (!fs.existsSync(path.join(here, 'node_modules', 'electron-builder'))) run('npm', ['install', '--no-audit', '--no-fund'], { cwd: here });
  run('npx', ['electron-builder', '--publish', 'never', ...extra], { cwd: here });
}

if (mode === 'stage') stage();
else if (mode === 'dist') {
  stage();
  builder(flags);
  console.log(`\nInstaller written to ${path.join(root, 'release')}`);
} else if (mode === 'smoke' || mode === 'run') {
  stage();
  if (!fs.existsSync(path.join(here, 'node_modules', 'electron'))) run('npm', ['install', '--no-audit', '--no-fund'], { cwd: here });
  // better-sqlite3 must match Electron's runtime, not the Node that ran npm install
  run('npx', ['electron-builder', 'install-app-deps'], { cwd: here });
  const electron = path.join(here, 'node_modules', '.bin', win ? 'electron.cmd' : 'electron');
  if (mode === 'run') run(electron, [app]);
  else {
    const shot = path.join(here, 'smoke.png');
    const env = { CUTROOM_SMOKE: '1', CUTROOM_SMOKE_OUT: shot };
    const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', app];
    if (process.platform === 'linux') run('xvfb-run', ['-a', electron, ...args], { env });
    else run(electron, args, { env });
    console.log(`Screenshot: ${shot}`);
  }
} else {
  console.error('Usage: node desktop/build.mjs stage|dist|smoke|run');
  process.exit(2);
}
