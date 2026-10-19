# Cutroom

A local-first, browser-based non-linear video editor where AI agents perform the editing.
Everything runs on your machine: a Vite/React web app on `:5173` and a Fastify server on `:3001`
that owns the project folder, FFmpeg, the analysis cache and (later) all model calls.

> **Status: build step 1 of 10 complete.** Open/upload, ffprobe import, CFR edit proxies, project
> persistence and the workspace shell work and are tested. Timeline, compositor, agents and export
> arrive in the following steps — see [Roadmap](#roadmap).

## Requirements

- Node 20+ and pnpm 10
- FFmpeg 5.1+ and ffprobe on `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH`).
  Needs `libx264` and `aac`; `libx265`, `prores_ks`, `libopus` and the `zscale` filter (HDR tone-mapping) are optional.
  The first screen explains what to install if anything is missing.
  - macOS: `brew install ffmpeg` · Windows: `winget install Gyan.FFmpeg` · Debian/Ubuntu: `sudo apt install ffmpeg`

## Run

```bash
pnpm install
pnpm dev            # web http://localhost:5173  ·  server http://127.0.0.1:3001
```

Production mode serves the built web app from the server:

```bash
pnpm build && pnpm start      # http://127.0.0.1:3001
```

Environment variables: `CUTROOM_PORT` (3001), `CUTROOM_HOST` (127.0.0.1), `CUTROOM_DATA_DIR`
(per-user settings + recent projects), `FFMPEG_PATH`, `FFPROBE_PATH`.

## Using it

1. Open `http://localhost:5173`, choose **Open folder…** (or paste a path). Cutroom scans it recursively,
   probes every media file and creates `<folder>/.cutroom/` (`project.json`, `proxies/`, `cache/`, `history/`, `index.sqlite`).
   Your originals are never modified.
2. Drag files or folders into the Media bin to add more (stored under `<folder>/uploads/`).
3. Proxies and thumbnails build in the background; the editor stays usable. Hover the dots on an item for per-stage status.
4. Re-opening the folder restores everything and only redoes missing work. Moved files are re-linked by content fingerprint;
   missing files can be relinked from the item menu.

## Time & accuracy rules

All time is rational: video in frames at the sequence rate (e.g. `30000/1001`), audio in samples at 48 kHz, exact seconds as
`{num, den}`. Floats appear only at the display edge. Imports are probed with ffprobe; variable-frame-rate sources are detected from
packet timestamps and conformed to constant frame rate in the proxy; rotation, pixel aspect ratio, colour range/space and HDR are
handled in the proxy (BT.709 limited, square pixels, short side ≤ 1080). Timecode is `HH:MM:SS:FF` and drop-frame aware.

## Repository layout

```
apps/web         Vite + React 18 + TypeScript (strict), Zustand, Radix primitives, CSS-variable tokens
apps/server      Fastify + WebSocket + better-sqlite3, FFmpeg/ffprobe orchestration, job queue
packages/core    Time model, timecode, media/project types, protocol types (shared by web + server)
packages/agents  (step 6)  Director + specialists + tools
packages/plugin-sdk (step 8)  Plugin / skill SDK
e2e              Playwright end-to-end tests
```

## Tests

```bash
pnpm test           # unit + integration (core, server with real FFmpeg, web)
pnpm typecheck
pnpm test:e2e       # Playwright (starts `pnpm dev` itself; uses /opt/pw-browsers/chromium if present)
pnpm gen:sync-asset out.mp4 10 30   # flash+beep A/V sync asset, prints measured offset
```

The A/V sync asset shows a single white frame and a 50 ms 1 kHz beep starting together at every whole second.
`analyzeSync()` in `apps/server/test/helpers/media.ts` measures where each lands after any processing; tests assert **0 frames** of offset.

## Security model

The server can read folders you point it at, so it only talks to pages on this machine: requests with a non-loopback `Host`
(DNS rebinding) or a foreign `Origin` are rejected with 403, including WebSocket upgrades, and it listens on `127.0.0.1` by default.

## Roadmap

1. ✅ Monorepo, FFmpeg check, project open/upload, import, ffprobe, proxies
2. Time model + timeline data model + edit engine + undo/redo + property tests *(time/timecode done)*
3. Timeline canvas, WebCodecs + WebGL compositor, audio graph, shortcuts
4. Media intelligence (waveforms, transcript, silences, scenes, beats, loudness)
5. Providers, settings, key storage, model/effort/mode selectors
6. Agent runtime: Director, specialists, tools, transactions, QA, chat cards, ghost diff
7. Keyframes, motion, transitions, effects, captions
8. Skills + plugins + MCP
9. Export pipeline + job queue
10. Polish, accessibility, performance, E2E + agent evals
