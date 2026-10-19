import { type Voice, planAudio } from '@cutroom/core';
import { useApp } from '../store/app';
import { type Baked, bakeWindow, mixToBlocks, openSources } from './scheduler';
import { SLICE_SAMPLES } from './mix';
import { envOf } from './sources';
import { peakDb } from './analyze';
import type { PcmSource } from './pcm';

const LEAD_S = 0.06; // time between "start" and the first sample leaving the speakers
const PRIME_SAMPLES = 24_000; // baked before the clock starts
const LOOKAHEAD_SAMPLES = 72_000;

/**
 * Live program audio. Voices from `planAudio` are baked in half-second blocks ahead of the clock and placed on the
 * AudioContext timeline at exact sample times; the context's clock is the master clock for the transport, so video
 * follows audio, never the other way round.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private meters: AnalyserNode[] = [];
  private epoch = 0;
  private t0 = 0;
  private from = 0;
  private scheduledTo = 0;
  private limit = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private readonly nodes = new Set<AudioBufferSourceNode>();
  private ratio = { rate: 48_000, tps: 1 };
  private voices: Voice[] = [];
  private sources = new Map<string, PcmSource | null>();
  private fromTicks = 0;

  running = false;
  starting = false;
  /** Set when the context could not start (e.g. autoplay policy); surfaced in the UI. */
  error: string | null = null;

  private ensureContext(sampleRate: number): AudioContext {
    if (this.ctx && this.ctx.sampleRate !== sampleRate) {
      void this.ctx.close();
      this.ctx = null;
    }
    if (!this.ctx) {
      const ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      const master = ctx.createGain();
      const split = ctx.createChannelSplitter(2);
      master.connect(ctx.destination);
      master.connect(split);
      this.meters = [0, 1].map((ch) => {
        const a = ctx.createAnalyser();
        a.fftSize = 2048;
        split.connect(a, ch);
        return a;
      });
      this.ctx = ctx;
      this.master = master;
    }
    return this.ctx;
  }

  /** Start (or restart) playback at `fromTicks`, scheduling no audio past `limitTicks`. */
  async start(fromTicks: number, limitTicks: number): Promise<void> {
    const epoch = this.halt();
    this.starting = true;
    try {
      const { sequence: seq, media } = useApp.getState();
      if (!seq) return;
      const tb = seq.timebase;
      const ctx = this.ensureContext(tb.sampleRate);
      await ctx.resume();
      const voices = planAudio(seq, envOf(media, seq));
      const sources = await openSources(voices, media);
      if (epoch !== this.epoch) return;
      this.voices = voices;
      this.sources = sources;
      this.ratio = { rate: tb.sampleRate, tps: tb.rate / tb.sampleRate };
      this.fromTicks = fromTicks;
      this.from = Math.round(fromTicks / this.ratio.tps);
      this.limit = Math.round(limitTicks / this.ratio.tps);
      const first = Math.min(this.limit, this.from + PRIME_SAMPLES);
      const blocks = await this.bake(this.from, first);
      if (epoch !== this.epoch) return;
      this.t0 = Math.ceil((ctx.currentTime + LEAD_S) * tb.sampleRate) / tb.sampleRate;
      this.place(blocks);
      this.scheduledTo = first;
      this.running = true;
      this.error = null;
      this.timer = setInterval(() => void this.pump(epoch), 80);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (epoch === this.epoch) this.starting = false;
    }
  }

  stop(): void {
    this.halt();
    this.starting = false;
  }

  private halt(): number {
    this.epoch++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.nodes.clear();
    this.running = false;
    this.pumping = false;
    return this.epoch;
  }

  /** Timeline position being heard right now, in ticks. */
  position(): number {
    const ctx = this.ctx;
    if (!ctx || !this.running) return this.fromTicks;
    const latency = ctx.outputLatency || ctx.baseLatency || 0;
    const samples = (ctx.currentTime - this.t0 - latency) * this.ratio.rate;
    return Math.max(this.fromTicks, (this.from + samples) * this.ratio.tps);
  }

  private async bake(from: number, to: number): Promise<Baked[]> {
    const seq = useApp.getState().sequence;
    if (!seq || to <= from) return [];
    return mixToBlocks(await bakeWindow(seq, this.voices, this.sources, from, to), from, to);
  }

  private place(blocks: Baked[]): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const sr = this.ratio.rate;
    for (const blk of blocks) {
      const buf = ctx.createBuffer(2, blk.frames, sr);
      buf.copyToChannel(blk.data[0], 0);
      buf.copyToChannel(blk.data[1], 1);
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(this.master);
      const when = this.t0 + (blk.sample - this.from) / sr;
      const now = ctx.currentTime;
      if (when >= now) node.start(when);
      else if (now - when < buf.duration) node.start(now, now - when); // baked late: skip what has already gone by
      else continue;
      this.nodes.add(node);
      node.onended = () => this.nodes.delete(node);
    }
  }

  private async pump(epoch: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || epoch !== this.epoch || this.pumping || !this.running) return;
    const playing = this.from + Math.floor((ctx.currentTime - this.t0) * this.ratio.rate);
    let target = Math.min(this.limit, playing + LOOKAHEAD_SAMPLES);
    if (target < this.limit) target = Math.floor(target / SLICE_SAMPLES) * SLICE_SAMPLES; // cut windows on slice boundaries
    if (target <= this.scheduledTo) return;
    this.pumping = true;
    try {
      const blocks = await this.bake(this.scheduledTo, target);
      if (epoch !== this.epoch) return;
      this.place(blocks);
      this.scheduledTo = target;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (epoch === this.epoch) this.pumping = false;
    }
  }

  /** Peak level per channel in dBFS over the last ~40 ms. */
  levels(): [number, number] {
    const out: [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    if (!this.running) return out;
    const buf = new Float32Array(2048);
    this.meters.forEach((a, i) => {
      a.getFloatTimeDomainData(buf);
      out[i] = peakDb(buf);
    });
    return out;
  }
}

export const audio = new AudioEngine();
