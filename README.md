# Cutroom

A local-first, browser-based non-linear video editor where AI agents perform the editing.
Everything runs on your machine: a Vite/React web app on `:5173` and a Fastify server on `:3001`
that owns the project folder, FFmpeg, the analysis cache and (later) all model calls.

> **Status: build steps 1–5 of 10 complete.** Open/upload, ffprobe import, CFR edit proxies, the edit engine with
> undo/redo, a canvas timeline, a WebCodecs + WebGL program monitor and a Web Audio mix are working and tested —
> including an automated proof that picture and sound stay on the same instant through split, trim, ripple and
> speed edits. Media intelligence (waveforms, filmstrip, loudness, silences, scenes, beats, transcript) is in too. Agents, effects and export arrive in the following steps — see [Roadmap](#roadmap).

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

## How editing works

- **Ticks.** Each sequence has one integer unit, `rate = lcm(fps.num, 48000)` ticks per second, so every video frame *and* every
  audio sample is a whole number of ticks (30 fps → 48 000, 29.97 → 240 000). Linked A/V is compared with integer arithmetic.
- **Edit engine** (`packages/core/src/edit`). Operations are zod-validated pure functions `(state, op) → { state, patches, inverse }`
  (Immer patches, so the inverse is exact). 39 operations (insert, overwrite, split, trim, ripple/roll trim, slip, slide, move,
  ripple delete, speed, keyframes, transitions, effects, captions, tracks, markers…) are grouped into transactions, and a
  `normalize` pass rejects anything that would leave overlap, off-grid video, media over-run or link desync. fast-check property
  tests run tens of thousands of random operations at 24/25/29.97/30/59.94 fps and assert that sync, geometry and undo hold.
- **The server owns the sequence.** `POST /api/edit` is atomic (op-indexed errors, stale-revision 409), autosaves into
  `project.json`, snapshots agent edits under `.cutroom/history`, and broadcasts Immer patches over the WebSocket; the browser
  mirrors them and refetches if it ever misses one.
- **Program monitor.** Video proxies (H.264, or VP9 when the browser cannot decode H.264 — the browser reports which) are demuxed
  with mp4box from a Range-fetched sample table and decoded GOP by GOP with WebCodecs; frames are composited in WebGL2. The frame
  for a timeline tick is chosen with integer arithmetic, so the flash frame of the sync asset lands on exactly its frame.
- **Audio.** `planAudio` turns the sequence into *voices* (mute/solo, gain, balance, fades, and 8 ms equal-power crossfades at cuts
  that have handle media). Voices are baked to stereo in half-second slices on absolute sample boundaries and placed on the
  `AudioContext` timeline at exact sample times; the audio clock is the playback master clock. Export uses the *same* slices through
  an `OfflineAudioContext`, so playback and export are the same samples.

## Media intelligence

After the proxies exist, every file is analysed in the background; results are cached under `.cutroom/cache/<media>/` and summarised in
`media.analysis` (what agents read without loading the whole thing). Reopening a folder only redoes what is missing.

| Stage | How | Output |
|---|---|---|
| Waveform | min/max peaks per 256 samples over the 48 kHz PCM proxy | `waveform.bin` (Int16 pairs; the timeline builds coarser levels) |
| Silences | 10 ms RMS windows < −40 dBFS lasting ≥ 0.3 s | sample-exact ranges |
| Loudness | ITU-R BS.1770-4 K-weighting + gating: integrated LUFS, LRA, momentary/short-term max, 4× true peak | checked against FFmpeg `ebur128` in tests |
| Beats | spectral-flux onsets → autocorrelation tempo → dynamic-programming beat tracker | bpm, confidence, beat times |
| Scenes | FFmpeg scene score on the CFR proxy | frame-exact cuts |
| Filmstrip | one sprite sheet of thumbnails | drawn on timeline clips |
| Transcript | whisper.cpp, one word per segment so every word has its own timing | words + sentence segments |

**Transcription** needs whisper.cpp and a ggml model; without them the stage shows *needs whisper.cpp* (everything else still works).
Set `WHISPER_CPP_BIN` and `WHISPER_MODEL`, or put `whisper-cli` on `PATH` and `ggml-*.bin` in `<app data>/models/`, then use *Check again*
in the Transcript tab.

## Model providers

Settings → **Providers** connects the models the agents will use: **OpenRouter**, **OpenAI**, **Anthropic**, **Google Gemini**, or any
**OpenAI-compatible** endpoint (Ollama, LM Studio, vLLM, a proxy…). In the Agent tab you pick the model (searchable, with any model id
typeable), the reasoning **effort** (Off / Low / Med / High / Max) and the **mode** (Ask: every edit waits for approval · Auto: edits
apply and are reviewed as a diff · Full access: agents may also run plugins/tools beyond the project). A meter shows tokens used against
the model's context window.

- **Keys never reach the browser.** They are sent to the local server once, sealed with AES-256-GCM (master key in
  `<app data>/secret.key`, owner-only) and stored as ciphertext; the API only ever returns "has key" and the last four characters.
  Provider errors are scrubbed of the key before they are shown or logged.
- **One chat interface, three wire formats.** The server speaks each provider natively — OpenAI-style chat completions (also used for
  OpenRouter and custom endpoints), Anthropic Messages, and Gemini `generateContent` — streaming, with tool calls, reasoning (Anthropic
  thinking blocks and Gemini thought signatures are carried across tool turns) and usage. Effort maps to `reasoning_effort` /
  `reasoning` / a thinking token budget as each API expects. All three are tested against local fake servers that check the exact
  request each provider would receive.

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
2. ✅ Time model + timeline data model + edit engine + undo/redo + property tests
3. ✅ Timeline canvas, WebCodecs + WebGL compositor, audio graph, shortcuts
4. ✅ Media intelligence (waveforms, filmstrip, transcript, silences, scenes, beats, loudness)
5. ✅ Providers, settings, key storage, model/effort/mode selectors
6. Agent runtime: Director, specialists, tools, transactions, QA, chat cards, ghost diff
7. Keyframes, motion, transitions, effects, captions
8. Skills + plugins + MCP
9. Export pipeline + job queue
10. Polish, accessibility, performance, E2E + agent evals
