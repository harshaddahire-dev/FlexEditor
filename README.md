# Cutroom

A local-first, browser-based non-linear video editor where **AI agents perform the editing**.
Everything runs on your machine: a Vite/React web app on `:5173` and a Fastify server on `:3001` that owns the project folder,
FFmpeg, the analysis cache, your model keys and every model call. Your footage is never uploaded anywhere.

You describe the edit ("remove the silences", "make a 30-second highlight", `/youtube-retention-cut`) and watch the timeline change.
A **Director** plans and delegates to specialists (Cutter, Audio, Captioner, Motion, Finisher, QA); every change is a validated,
undoable engine operation, grouped so a whole agent run can be kept or undone in one click, and reviewed as a ghost diff on the timeline.

> **All ten build steps are complete and tested** — see [Tests](#tests) and the [Roadmap](#roadmap) for what is covered and how.
> Picture and sound are proven to stay on the same instant (0 frames of offset) from import through every edit, through the
> browser export path and through the FFmpeg export path.

```
┌────────────────────────────── Browser · apps/web ──────────────────────────────────┐
│ React UI · Zustand stores (sequence mirror kept current with Immer patches)         │
│ Timeline (Canvas2D) · Program monitor: WebCodecs decode → WebGL2 compositor          │
│   (transform · effects · transitions · captions)                                     │
│ Audio: planAudio → baked 0.5 s slices → AudioContext (live) / OfflineAudioContext    │
│ Exporter: same compositor → VideoEncoder → encoded chunks ─────────────┐             │
└───────────────▲───────────────────────────┬──────────────────────────────┼───────────┘
   REST + WebSocket: edits, patches, jobs,   │ agent events, export         │ upload (audio WAV, video)
┌───────────────┴───────────────────────────▼──────────────────────────────▼───────────┐
│ Server · apps/server (Fastify, better-sqlite3)                                       │
│  ProjectManager ─ EditSession ─ packages/core: time model · edit engine · history    │
│  Media pipeline: ffprobe → CFR proxies → waveform · loudness · silences · beats ·     │
│                  scenes · filmstrip · whisper.cpp transcript                         │
│  Providers: AES-256-GCM key store · OpenAI-compatible · Anthropic · Gemini adapters   │
│  AgentService ─ packages/agents: Director + specialists, typed tools, QA loop         │
│  Extensions: skills (SKILL.md) · plugins (packages/plugin-sdk) · MCP client           │
│  ExportService: FFmpeg filtergraph renderer · mux · SRT/VTT · job queue               │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                                        │ spawn
                              FFmpeg · ffprobe · whisper.cpp
```

## Desktop app (no terminal, nothing to install first)

Cutroom also ships as a normal desktop application: one installer that contains the editor, its server, **FFmpeg and ffprobe**, and an
Electron window — no Node, pnpm or FFmpeg setup. Projects, keys and settings live in your user profile; your footage stays where it is.

- **Get an installer.** Open the repository's **Actions → Desktop installers → Run workflow** (or push a tag such as `v0.1.0`, which also
  publishes a GitHub release). When it finishes, download `cutroom-windows-latest` (`Cutroom-<version>-win-x64.exe`),
  `cutroom-macos-latest` (`.dmg`) or `cutroom-ubuntu-latest` (`.AppImage`).
- **Or build it yourself** on the OS you want it for (needs Node 22 and pnpm 10):

  ```bash
  pnpm install
  pnpm desktop:dist        # writes the installer to ./release
  pnpm desktop             # or just run the desktop app from source
  ```

- The installers are not code-signed: Windows SmartScreen shows "More info → Run anyway", and on macOS use right-click → Open.
- The desktop app adds a native folder dialog and "Show in folder" after a render. Electron's Chromium decodes and encodes H.264, so
  renders normally use the fast browser engine straight from your original files. `pnpm desktop:smoke` and `pnpm desktop:test` check
  the packaged app end to end (window, server, FFmpeg, open a folder, render, 0 frames of A/V offset).

### Updates

The desktop app keeps itself current from this repository's GitHub releases.

- **Windows (installed) and Linux (AppImage)** update in place: about 15 seconds after start, and every 4 hours, the app checks quietly;
  a new version downloads in the background (Windows downloads only the changed blocks) and installs when you restart. A **Restart to
  update to x.y.z** button appears in the top bar when it is ready — if a render or agent run is in progress it asks before restarting.
  Nothing is installed while you are working, and a failed background check (offline, rate limit) says nothing.
- **macOS** builds are not code-signed, and macOS only lets signed apps replace themselves. There the app tells you a new version exists
  and **Get x.y.z** opens the download page; install it over the old one (projects and settings are kept).
- **Settings → System → About & updates** shows the installed version, when it last checked and the release notes, has **Check for
  updates**, and a switch to turn automatic downloads off. **Help → Check for updates…** does the same from the menu.
- **Publishing a release.** Every push to `main` builds all three installers and publishes release `v0.1.<run number>`; push a tag such as
  `v1.2.0` to publish exactly that version. The release carries `latest*.yml` and `.blockmap` files — that is what installed apps read,
  so keep them. Versions only go up (apps never downgrade). Builds made before updates existed (v0.1.0) need one manual reinstall.
- Testing without a release: set `CUTROOM_UPDATE_URL` to a folder served over http that contains a `latest-<os>.yml` (see
  `desktop/test/updates.spec.ts`).

## Requirements

- Node 20+ and pnpm 10
- FFmpeg 5.1+ and ffprobe on `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH`).
  Needs `libx264` and `aac`; `libx265`, `prores_ks`, `libopus` and the `zscale` filter (HDR tone-mapping) are optional.
  The first screen explains what to install if anything is missing.
  - macOS: `brew install ffmpeg` · Windows: `winget install Gyan.FFmpeg` · Debian/Ubuntu: `sudo apt install ffmpeg`

## Run from source

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
  Proxies of long or 4K clips take a while (they are queued ahead of analysis, made with a fast encoder preset, and shown with a
  progress bar); until one exists the monitor decodes the original file when this machine can, so the picture never waits.
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

**Transcription** needs whisper.cpp and a ggml model. The app detects whether they are there; if not, the Transcript tab and
Settings → System → Transcription show **Install transcription** — one click, with a progress bar and a choice of model
(Tiny 75 MB, Base 142 MB, Small 466 MB). It puts everything in `<app data>/whisper` and `<app data>/models`, then transcribes the
media that was waiting. It downloads only when you click, and works offline afterwards.

- **Windows:** downloads the prebuilt `whisper-bin-x64.zip` from the whisper.cpp GitHub release and the model from Hugging Face.
- **macOS:** runs `brew install whisper-cpp` (needs Homebrew) and downloads the model.
- **Linux:** builds whisper.cpp from the release source (needs `cmake` and a C++ compiler) and downloads the model.
- Where none of that is possible the card says what to install. You can always set `WHISPER_CPP_BIN` and `WHISPER_MODEL`, or put
  `whisper-cli` on `PATH` and `ggml-*.bin` in `<app data>/models/`, then use *Check again* in the Transcript tab.

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

## Agents

Ask in the Agent tab ("remove the silences", "make a 30-second highlight") and watch the timeline change. A **Director** plans the
edit, does simple edits itself and delegates focused jobs to specialists — **Cutter** (structure, pacing, removing mistakes), **Audio**
(levels, fades, loudness), **Motion** (keyframed animation), **Captioner**, **Finisher** and **QA** (independent review, never edits).
Each specialist has its own prompt and only the tools it needs.

- **Typed tools, one engine.** The agents read through `get_overview`, `get_sequence`, `get_transcript`, `get_words`, `get_silences`,
  `get_scenes`, `get_beats`, `get_loudness`, `validate`, and edit through `add_clip`, `split`, `trim`, `remove_range`, `move_clips`,
  `set_speed`, `set_clip`, `add_keyframes`… Times are seconds or timecode; every edit becomes the same validated operations the UI uses,
  so an agent cannot overlap clips, break sync or leave the frame grid — the engine refuses, and the model is told why.
- **Modes.** *Ask*: every edit waits for your approval (Approve / Deny / Approve all this run). *Auto*: edits apply immediately.
  *Full access* also lets agents use plugins and external tools. Reads never need approval.
- **One undo per run.** All edits of a run share a transaction group (`origin: agent:<role>`). The chat card shows what changed
  (`+4 · −1 · ~2`), with **Keep** (clears the "AI" markers), **Undo all**, and a **Changes** overlay that draws removed and moved
  items as dashed ghosts on the timeline.
- **Automatic QA.** After a run, the sequence is audited again; problems the run introduced (flash frames, gaps, desync, audio clicks)
  go back to the Director for up to two fix rounds. Pre-existing problems are not blamed on the agent.
- **Safe by construction.** Runs stream over the WebSocket, can be stopped at any point (including while waiting for approval),
  survive a restart as a transcript in `.cutroom/chat.json`, and run one at a time per project.
- **Tested without a model.** `packages/agents` is exercised with a scripted stand-in for the model against the real edit engine;
  the server and e2e suites drive full runs through a fake OpenAI-compatible endpoint.

## Motion, effects, transitions and captions

- **Keyframes.** Every Inspector value has a diamond: click to add a keyframe at the playhead, and the value animates between
  keyframes (linear, hold or an ease curve — the diamond cycles through them). Position, scale, rotation, anchor, opacity, crop,
  audio gain and every effect parameter can be animated. Curves are the same cubic Béziers in the engine, the monitor and the exporters.
- **Effects** (WebGL shader passes, in the order listed on the clip): Color (exposure, brightness, contrast, saturation, temperature,
  tint), Look (warm film, teal & orange, bleach bypass, noir, faded), Gaussian blur, Sharpen, Vignette, Sepia, Pixelate. Drag from the
  Effects tab or use the Inspector; agents use `apply_effect` / `set_effect`.
- **Transitions**: dissolve, dip to black / white, four wipes, slide, push (both ways), zoom and iris — written as small GLSL functions
  in the gl-transitions convention (`transition(uv)`), drawn between the two clips with their real handle media, so footage keeps
  moving through the transition. A cut without enough spare footage is refused with the reason.
- **Captions** are generated from the transcript (`captionsForClip`): grouped by sentence, pause and line length, mapped through
  trims and speed, snapped to frames and never overlapping. Five styles — Clean, Bold pop (spoken word highlighted), Minimal, Boxed,
  Karaoke — are drawn on a canvas layer by the compositor, so what you see is what is burned in. Edit the text in the Captions tab or the
  Inspector; export as burned-in, as `.srt`/`.vtt`, or both.

## Skills, plugins and MCP

**Skills** are step-by-step recipes the Director follows. A skill is a folder with a `SKILL.md`:

```markdown
---
name: podcast-cleanup
description: Clean up a conversation or podcast recording — trim long pauses, balance speakers, normalise loudness.
---
1. get_overview; get_loudness and get_silences for each media item.
2. Shorten pauses longer than 1.2 s to about 0.6 s with remove_range …
```

Eight ship with Cutroom (`skills/`): YouTube retention cut, podcast cleanup, short-form vertical reel, highlight reel, beat-synced
montage, interview rough cut, loudness master, chapter markers. Add your own in `<app data>/skills/` or `<project>/.cutroom/skills/`
(a project skill with the same name wins). Run one from the **Skills** tab, or type `/` in the Agent tab to pick from a menu.

**Plugins** are folders with a `plugin.json` and an ES module that `export default definePlugin({ id, name, version, tools, skills })`
(`packages/plugin-sdk`). Tools declare a zod schema or plain JSON Schema and receive a context with the sequence, the media, the
analysis and an `applyOps()` that goes through the same validated, undoable engine as everything else. `plugins/pacing-tools` is a
working example.

**MCP servers** (stdio commands or streamable-HTTP URLs) are added in Settings → *Plugins & MCP*; their tools show up next to the
built-in ones. Environment variables and headers are encrypted at rest like provider keys and are never sent back to the browser.

Plugins and MCP servers run code outside Cutroom with your permissions, so their tools are offered to the agents **only in Full access
mode**, never to the specialists, and each one can be switched off.

## Exporting

**Render** (top right) writes to `<project>/exports/`:

| Preset | Video | Audio |
|---|---|---|
| H.264 · MP4 | x264 / browser H.264, Rec.709 tagged | AAC 320 k |
| VP9 · WebM | libvpx-vp9 / browser VP9 | Opus 192 k |
| ProRes 422 HQ · MOV | `prores_ks`, 10-bit 4:2:2 | 24-bit PCM |
| Audio only · WAV | — | 24-bit PCM |

Ranges (whole timeline or In → Out), half-size output, captions (burned in, `.srt` + `.vtt`, both, none) and a cancel button are in the
dialog. Two renderers produce the picture; the **audio is always mixed in the browser** with the playback graph through an
`OfflineAudioContext` (so export is the playback mix, sample for sample) and muxed on the server:

- **Browser (WebCodecs)** — the same compositor as the monitor renders each frame from the *original* files (or from proxies for a
  fast draft), `VideoEncoder` encodes it, the chunks stream to the server and FFmpeg only muxes (`-c copy`).
- **FFmpeg** — the server builds one `filter_complex` from the sequence (trim, speed, transform, keyframed expressions, opacity, crop,
  effects, `xfade` transitions, ASS captions) and renders from the originals. Used for ProRes and whenever the browser cannot decode a
  source (for example H.264 in a browser without it) or encode the target.

*Automatic* picks for you and says why. The two engines are checked against each other in the e2e suite on a composed scene
(stacking, transform, opacity, an effect, a dissolve). The FFmpeg engine approximates a few effects and transitions (vignette, teal &
orange, pixelate, dip-to-black timing, iris/zoom) and lists exactly which ones in the result.

## Repository layout

```
desktop/         Electron shell + installer build (build.mjs, electron-builder config); not part of the pnpm workspace
apps/web         Vite + React 18 + TypeScript (strict), Zustand, Radix primitives, CSS-variable tokens
apps/server      Fastify + WebSocket + better-sqlite3, FFmpeg/ffprobe orchestration, job queue
packages/core    Time model, timecode, media/project types, protocol types (shared by web + server)
packages/agents  Director + specialists + typed tools + runtime (model-agnostic, tested with a scripted model)
packages/plugin-sdk  Plugin and skill SDK (definePlugin, SKILL.md parser, tool adapters)
skills/          The built-in skills (SKILL.md)
plugins/         Example plugin(s)
e2e              Playwright end-to-end tests (+ opt-in screenshot specs tagged @shots)
```

## Keyboard

Everything is on the keyboard; `Ctrl/⌘ K` opens the command palette (every action, searchable, with its shortcut).

| | |
|---|---|
| Play / pause · shuttle | `Space` · `J` `K` `L` |
| Step a frame · ten frames | `←` `→` · `Shift+←` `Shift+→` |
| Previous / next edit point · start / end | `↑` `↓` · `Home` `End` |
| Mark in / out · clear | `I` `O` · `Alt+X` |
| Select · blade · track-select-forward tool | `V` · `C` · `A` |
| Split at playhead | `Shift+C` |
| Ripple trim start / end to playhead | `Q` `W` |
| Insert / overwrite selected media | `,` `.` |
| Delete · ripple delete | `Delete` · `Shift+Delete` |
| Marker · snapping · linked selection | `M` · `S` · `Shift+L` |
| Undo · redo | `Ctrl/⌘ Z` · `Ctrl/⌘ Shift Z` |
| Zoom in / out / fit | `+` `-` `Shift+Z` |
| Focus the agent chat · settings · render | `Ctrl/⌘ L` · `Ctrl/⌘ ,` · `Ctrl/⌘ Shift+E` |

## Accessibility

The UI follows WCAG 2.1 AA and is checked in CI with axe-core on every screen (workspace, every panel tab, agent chat, Settings,
Render, command palette, light and dark themes). Text meets 4.5:1 contrast in both themes; panels use real landmarks, roles and
labels; dialogs trap and restore focus (Radix). The canvas timeline is one tab stop with instructions and has a text twin: a list of
every clip you can activate to select it and move the playhead, plus the selection announced as it changes. Bin items open their
menu with the Menu key or `Shift+F10`.

## Performance

Measured by the test suites (numbers from a small shared CI-class machine, software WebGL):

- **Timeline:** 1,200 clips with the whole timeline in view — zoom and pan on the 60 Hz cadence (≥ 88 % of frames within 20 ms; the drawing itself takes ≈ 0.7 ms). Far-zoomed clips draw as plain
  blocks (level of detail); only clips in the viewport are drawn at all.
- **Edit engine:** local edits on a 1,200-clip sequence take 1–40 ms (limit 50 ms); an edit's Immer patch touches only what changed.
- **Agent tools:** every read and edit tool call finishes in under 50 ms on a 1,200-clip timeline (reads ≈ 1 ms, edits 3–40 ms),
  model latency excluded.
- **Playback:** the audio clock is the master clock; frames are chosen with integer arithmetic and decoded GOP by GOP with
  look-ahead, so the picture never waits at a GOP boundary.

## Tests

```bash
pnpm test           # unit + integration (core, agents, plugin-sdk, server with real FFmpeg, web)
pnpm typecheck
pnpm test:e2e       # Playwright (starts `pnpm dev` itself; uses /opt/pw-browsers/chromium if present)
pnpm desktop:test   # the packaged desktop app, driven with Playwright's Electron support (after `pnpm desktop:smoke` has built it)
pnpm eval           # agent evals against scripted trajectories (no model needed)
pnpm eval:live      # the same evals against a real model — see below
pnpm gen:sync-asset out.mp4 10 30   # flash+beep A/V sync asset, prints measured offset
```

| Suite | What it proves |
|---|---|
| `packages/core` (173) | rational time and timecode (drop-frame), the 39 edit operations, undo/redo, **fast-check property tests** over random operations at 24/25/29.97/30/59.94 fps (sync, geometry, undo), keyframes, audio planning, DSP (loudness vs FFmpeg `ebur128`), captions, effects, edit latency |
| `packages/agents` (33) | the runtime, roles and every tool against the real engine with a scripted model; approvals, undo groups, QA loop; skills and external tools; **agent evals** (10 scenarios scored on the resulting timeline, plus negative controls that must fail); tool latency on 1,200 clips |
| `apps/server` (164) | import/probe/proxies with real FFmpeg (VFR, rotated, anamorphic, HDR), **A/V sync through the proxy conform (0 frames)**, analysis pipeline, provider adapters against fake servers, key encryption, agent runs, extensions (a real MCP server over stdio and HTTP), **the FFmpeg export engine with golden-pixel checks** (cuts, gaps, transform, opacity, keyframes, dissolve, effects, speed, VFR, captions, sidecars, ProRes) |
| `apps/web` (82) | timeline geometry and drawing, commands, layers, audio planning/mixing, event reducer |
| `e2e` (Playwright) | every build step end to end in a real browser: import → proxies → intelligence; timeline editing; **flash/beep sync after split, trim, ripple and speed**; providers; agent runs (stream, approve, deny, stop, undo); effects/transitions/captions as **real compositor pixels**; skills, plugins and MCP; **exports through both engines with 0 frames of A/V offset and a cross-engine pixel comparison**; axe accessibility; 1,200-clip timeline frame rate |

The A/V sync asset shows a single white frame and a 50 ms 1 kHz beep starting together at every whole second.
`analyzeSync()` in `apps/server/test/helpers/media.ts` measures where each lands after any processing; tests assert **0 frames** of offset
— for proxies, for every edit, and for files exported by either renderer.

### Agent evals

`packages/agents/evals` holds scenarios such as *remove the long silence*, *cut the "um"*, *30-second highlight*, *bold-pop captions*,
*normalize to −16 LUFS*, *dissolve between clips*, *answer a question without editing*, *respect a refusal in Ask mode*, *recover from a
wrong clip id* and */skill commands*. Each runs over a small synthetic project and is **judged on the resulting timeline** (valid, in
sync, the right amount removed, the right gain…), not on the path taken. `pnpm eval` runs a scripted trajectory per scenario (this proves
every outcome is reachable with the real tools and that the checks catch wrong results). To score a model:

```bash
EVAL_PROVIDER=openrouter EVAL_API_KEY=sk-… EVAL_MODEL=anthropic/claude-sonnet-4.5 pnpm eval:live
EVAL_PROVIDER=custom EVAL_BASE_URL=http://localhost:11434/v1 EVAL_MODEL=llama3.1 pnpm eval:live remove-silence highlight-30s
```

## Security model

The server can read folders you point it at, so it only talks to pages on this machine: requests with a non-loopback `Host`
(DNS rebinding) or a foreign `Origin` are rejected with 403, including WebSocket upgrades, and it listens on `127.0.0.1` by default.

## Roadmap

1. ✅ Monorepo, FFmpeg check, project open/upload, import, ffprobe, proxies
2. ✅ Time model + timeline data model + edit engine + undo/redo + property tests
3. ✅ Timeline canvas, WebCodecs + WebGL compositor, audio graph, shortcuts
4. ✅ Media intelligence (waveforms, filmstrip, transcript, silences, scenes, beats, loudness)
5. ✅ Providers, settings, key storage, model/effort/mode selectors
6. ✅ Agent runtime: Director, specialists, tools, transactions, QA, chat cards, ghost diff
7. ✅ Keyframes, motion, transitions, effects, captions
8. ✅ Skills + plugins + MCP
9. ✅ Export pipeline + job queue (WebCodecs and FFmpeg engines, sidecar subtitles)
10. ✅ Polish, accessibility, performance, E2E + agent evals

### Known limits

- Transcripts need whisper.cpp and a ggml model: install them with one click from the Transcript tab (everything else works without them).
- The browser export engine decodes one GOP at a time; very long-GOP 4K sources are routed to the FFmpeg engine automatically.
- The FFmpeg engine approximates vignette, teal & orange, pixelate and a few transitions, and animates effect parameters at their
  clip-start value; the result says which approximations were used.
- Plugins and MCP servers run with your permissions (that is why they are Full-access only).
