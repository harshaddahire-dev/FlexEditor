import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runText } from '../proc';

export interface TranscriptWord {
  text: string;
  /** Milliseconds from the start of the media. */
  startMs: number;
  endMs: number;
}

export interface Transcript {
  engine: 'whisper.cpp';
  model: string;
  language: string;
  words: TranscriptWord[];
  /** Words grouped into sentences (split on terminal punctuation or long pauses). */
  segments: { text: string; startMs: number; endMs: number; wordStart: number; wordEnd: number }[];
}

export interface WhisperInstall {
  bin: string;
  model: string;
}

const BIN_NAMES = ['whisper-cli', 'whisper-cpp', 'whisper.cpp'];

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Locate whisper.cpp and a ggml model: `WHISPER_CPP_BIN` / `WHISPER_MODEL`, else PATH and `<data>/models`. */
export async function findWhisper(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<WhisperInstall | null> {
  let bin: string | null = null;
  if (env.WHISPER_CPP_BIN) bin = (await isFile(env.WHISPER_CPP_BIN)) ? env.WHISPER_CPP_BIN : null;
  else {
    for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      for (const n of BIN_NAMES) {
        const p = path.join(dir, process.platform === 'win32' ? `${n}.exe` : n);
        if (await isFile(p)) {
          bin = p;
          break;
        }
      }
      if (bin) break;
    }
  }
  if (!bin) return null;

  let model: string | null = env.WHISPER_MODEL && (await isFile(env.WHISPER_MODEL)) ? env.WHISPER_MODEL : null;
  if (!model) {
    const dir = path.join(dataDir, 'models');
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /^ggml-.*\.bin$/.test(f));
    // prefer a mid-size multilingual-capable model, then whatever exists
    const rank = (f: string) => ['base', 'small', 'tiny', 'medium'].findIndex((s) => f.includes(`-${s}`));
    names.sort((a, b) => (rank(a) < 0 ? 9 : rank(a)) - (rank(b) < 0 ? 9 : rank(b)) || a.localeCompare(b));
    if (names[0]) model = path.join(dir, names[0]);
  }
  return model ? { bin, model } : null;
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: { offsets: { from: number; to: number }; text: string }[];
}

/** Turn whisper.cpp's one-word-per-segment JSON into clean words. Exported for tests. */
export function parseWhisperJson(json: WhisperJson, model: string): Transcript {
  const words: TranscriptWord[] = [];
  for (const seg of json.transcription ?? []) {
    const text = seg.text.trim();
    // non-speech annotations: [BLANK_AUDIO], (music), *clap*, ♪ …
    if (!text || /^[[(*♪].*[\])*♪]$/.test(text)) continue;
    const prev = words.at(-1);
    // a bare punctuation segment belongs to the previous word
    if (prev && /^[.,!?;:…"')\]-]+$/.test(text)) {
      prev.text += text;
      prev.endMs = Math.max(prev.endMs, seg.offsets.to);
      continue;
    }
    words.push({ text, startMs: seg.offsets.from, endMs: Math.max(seg.offsets.to, seg.offsets.from) });
  }
  const segments: Transcript['segments'] = [];
  let from = 0;
  words.forEach((w, i) => {
    const next = words[i + 1];
    const end = !next || /[.!?…]["')\]]*$/.test(w.text) || next.startMs - w.endMs > 1200;
    if (!end) return;
    const slice = words.slice(from, i + 1);
    segments.push({ text: slice.map((x) => x.text).join(' '), startMs: slice[0]!.startMs, endMs: w.endMs, wordStart: from, wordEnd: i + 1 });
    from = i + 1;
  });
  return { engine: 'whisper.cpp', model: path.basename(model), language: json.result?.language ?? 'auto', words, segments };
}

/** Run whisper.cpp on an audio file (any ffmpeg-readable input; it is converted to 16 kHz mono first). */
export async function transcribe(install: WhisperInstall, ffmpeg: string, audio: string, opts: { signal?: AbortSignal; language?: string } = {}): Promise<Transcript> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-whisper-'));
  try {
    const wav = path.join(tmp, 'in.wav');
    const conv = await runText(ffmpeg, ['-y', '-hide_banner', '-nostdin', '-v', 'error', '-i', audio, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal: opts.signal });
    if (conv.code !== 0) throw new Error(`could not prepare audio for transcription: ${conv.stderr.trim().split('\n').pop() ?? ''}`);
    const base = path.join(tmp, 'out');
    // -ml 1 -sow: one word per segment, so every word carries its own start/end
    const args = ['-m', install.model, '-f', wav, '-oj', '-of', base, '-ml', '1', '-sow', '-np', '-l', opts.language ?? 'auto'];
    const r = await runText(install.bin, args, { signal: opts.signal });
    if (r.code !== 0) throw new Error(`whisper.cpp failed: ${(r.stderr || r.stdout).trim().split('\n').pop() ?? ''}`);
    const json = JSON.parse(await fs.readFile(`${base}.json`, 'utf8')) as WhisperJson;
    return parseWhisperJson(json, install.model);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
