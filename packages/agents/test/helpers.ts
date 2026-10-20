import { type ChatEvent, type ChatRequest, type ChatResult, EditError, Editor, type EditEnv, type Media, type Op, type Sequence, createSequence, emptyStatus, frameTicks, mediaRef } from '@cutroom/core';
import { type AgentHost, type AnalysisKind, HostEditError, type LlmClient, type RunEvent } from '../src';

export const FPS = { num: 30, den: 1 };

export function media(id: string, name: string, seconds: number, o: { video?: boolean; audio?: boolean } = {}): Media {
  const video = o.video ?? true;
  const audio = o.audio ?? true;
  return {
    id,
    path: `${name}`,
    type: video ? 'video' : 'audio',
    name,
    sizeBytes: 1000,
    mtimeMs: 1,
    duration: { num: seconds, den: 1 },
    ...(video ? { fps: FPS, video: { codec: 'h264', width: 1920, height: 1080 } as never } : {}),
    audioChannels: audio ? 2 : 0,
    ...(audio ? { audio: { codec: 'aac', sampleRate: 48000, channels: 2 } as never } : {}),
    status: { ...emptyStatus(), transcript: 'done', silences: 'done', loudness: 'done', scenes: 'done', beats: 'done' },
    missing: false,
    warnings: [],
    analysis: {},
    importedAt: '',
  } as Media;
}

export const ANALYSIS: Record<string, Partial<Record<AnalysisKind, unknown>>> = {
  m_int: {
    transcript: {
      words: [
        { text: 'Hello', startMs: 1000, endMs: 1400 },
        { text: 'there.', startMs: 1400, endMs: 1900 },
        { text: 'Um', startMs: 5000, endMs: 5400 },
        { text: 'anyway.', startMs: 5400, endMs: 6000 },
      ],
      segments: [
        { text: 'Hello there.', startMs: 1000, endMs: 1900, wordStart: 0, wordEnd: 2 },
        { text: 'Um anyway.', startMs: 5000, endMs: 6000, wordStart: 2, wordEnd: 4 },
      ],
    },
    silences: { sampleRate: 48000, ranges: [{ start: 48000 * 2, end: 48000 * 4.5 }] },
    loudness: { integrated: -24.1, range: 5, truePeak: -3 },
    beats: { bpm: 120, confidence: 0.8, beats: [0.5, 1, 1.5] },
    scenes: { cuts: [{ frame: 90, time: 3 }] },
  },
};

export interface TestHost extends AgentHost {
  editor: Editor;
  calls: { ops: Op[]; label: string; origin: string; group: string }[];
}

export function makeHost(llm: LlmClient, extra: Media[] = []): TestHost {
  const seq = createSequence({ width: 1920, height: 1080, fps: FPS });
  const list = [media('m_int', 'interview.mp4', 60), media('m_broll', 'broll.mp4', 30, { audio: false }), ...extra];
  const env: EditEnv = { getMedia: (id) => (list.find((m) => m.id === id) ? mediaRef(list.find((m) => m.id === id)!, seq.timebase) : undefined) };
  const editor = new Editor(seq, env);
  const calls: TestHost['calls'] = [];
  return {
    llm,
    editor,
    calls,
    env,
    sequence: () => editor.state,
    media: () => list,
    analysis: async (id, kind) => ANALYSIS[id]?.[kind] ?? null,
    applyOps(ops, o) {
      calls.push({ ops, ...o });
      editor.begin(o.label, o.origin as never, o.group);
      try {
        ops.forEach((op, i) => {
          try {
            editor.apply(op);
          } catch (e) {
            if (e instanceof EditError) throw new HostEditError(`Operation ${i + 1} (${op.type}) was rejected: ${e.message}`, e.code);
            throw e;
          }
        });
      } catch (e) {
        editor.rollback();
        throw e;
      }
      editor.commit();
      return { revision: editor.revision };
    },
  };
}

export type Turn = (req: ChatRequest, n: number) => { text?: string; calls?: { name: string; args: Record<string, unknown> }[] };

/** A deterministic stand-in for a model: each request is answered by the next scripted turn. */
export function scripted(turns: Turn[]): LlmClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async *stream(req, signal) {
      const n = requests.length;
      requests.push(JSON.parse(JSON.stringify(req)));
      if (signal?.aborted) throw new Error('aborted');
      const turn = turns[Math.min(n, turns.length - 1)]!;
      const out = turn(req, n);
      if (out.text) yield { type: 'text', delta: out.text } as ChatEvent;
      const result: ChatResult = {
        text: out.text ?? '',
        toolCalls: (out.calls ?? []).map((c, i) => ({ id: `call_${n}_${i}`, name: c.name, arguments: c.args })),
        usage: { inputTokens: 100 + n * 50, outputTokens: 20 },
        stopReason: out.calls?.length ? 'tool_calls' : 'stop',
      };
      yield { type: 'done', result };
    },
  };
}

export const collect = (): { events: RunEvent[]; emit(e: RunEvent): void } => {
  const events: RunEvent[] = [];
  return { events, emit: (e) => events.push(e) };
};

export const frame = (seq: Sequence): number => frameTicks(seq.timebase);
