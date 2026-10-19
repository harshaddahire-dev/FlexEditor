import { describe, expect, it } from 'vitest';
import { type Editor, type JobInfo, type Media, type ProjectSummary, Editor as Ed, createSequence } from '@cutroom/core';
import { applyServerEvent, type LiveState } from '../src/store/events';

const summary: ProjectSummary = { id: 'p', name: 'P', folder: '/p', settings: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, sampleRate: 48000 }, mediaCount: 0, ignoredCount: 0 };
const media = (id: string): Media => ({ id, name: `${id}.mp4` }) as Media;
const job = (id: string, finishedAt?: number): JobInfo => ({ id, kind: 'proxy', label: id, state: finishedAt ? 'done' : 'running', progress: 0, createdAt: 0, finishedAt });
const base = (): LiveState => ({ project: summary, media: {}, jobs: {}, selectedMediaId: null, lastScan: null, sequence: null, revision: 0, sequenceStale: false, history: null });

describe('applyServerEvent', () => {
  it('hello replaces jobs and project', () => {
    const r = applyServerEvent(base(), { type: 'hello', jobs: [job('a')], project: null });
    expect(r).toEqual({ jobs: { a: job('a') }, project: null });
  });

  it('upserts media and jobs', () => {
    let s = base();
    s = { ...s, ...applyServerEvent(s, { type: 'media', media: media('m1') }) };
    s = { ...s, ...applyServerEvent(s, { type: 'media', media: { ...media('m1'), name: 'renamed.mp4' } }) };
    expect(Object.keys(s.media)).toEqual(['m1']);
    expect(s.media.m1!.name).toBe('renamed.mp4');
    s = { ...s, ...applyServerEvent(s, { type: 'job', job: job('j1') }) };
    s = { ...s, ...applyServerEvent(s, { type: 'job', job: { ...job('j1'), progress: 0.5 } }) };
    expect(s.jobs.j1!.progress).toBe(0.5);
  });

  it('drops late media events after the project is closed', () => {
    const s = { ...base(), project: null };
    expect(applyServerEvent(s, { type: 'media', media: media('late') })).toEqual({});
  });

  it('closing the project clears media, selection and scan', () => {
    const s: LiveState = { ...base(), media: { m1: media('m1') }, selectedMediaId: 'm1' };
    expect(applyServerEvent(s, { type: 'project', project: null })).toMatchObject({ project: null, media: {}, selectedMediaId: null, lastScan: null, sequence: null, sequenceStale: false });
  });

  it('removing media clears the selection only if it was selected', () => {
    const s: LiveState = { ...base(), media: { a: media('a'), b: media('b') }, selectedMediaId: 'a' };
    expect(applyServerEvent(s, { type: 'mediaRemoved', mediaId: 'a' })).toMatchObject({ selectedMediaId: null });
    expect(applyServerEvent(s, { type: 'mediaRemoved', mediaId: 'b' })).toMatchObject({ selectedMediaId: 'a' });
  });

  it('bounds the job history, dropping the oldest finished jobs first', () => {
    let s = base();
    for (let i = 0; i < 100; i++) s = { ...s, ...applyServerEvent(s, { type: 'job', job: job(`done${i}`, 1000 + i) }) };
    s = { ...s, ...applyServerEvent(s, { type: 'job', job: job('live') }) };
    s = { ...s, ...applyServerEvent(s, { type: 'job', job: job('late', 5000) }) };
    expect(Object.keys(s.jobs)).toHaveLength(100);
    expect(s.jobs.live).toBeDefined();
    expect(s.jobs.done0).toBeUndefined();
    expect(s.jobs.late).toBeDefined();
  });
});


describe('sequence mirror', () => {
  const media = { av: { id: 'av', kind: 'video' as const, duration: 48000 * 60, hasVideo: true, hasAudio: true } };
  const editor = (): Editor => new Ed(createSequence({ width: 1920, height: 1080, fps: { num: 30, den: 1 } }), { getMedia: (id) => media[id as 'av'] });
  const addClip = (ed: Editor, at: number) =>
    ed.apply({ type: 'insert', at, clips: [{ trackId: ed.state.tracks[0]!.id, mediaId: 'av', sourceIn: 0, sourceOut: 48000 * 2 }] });

  it('follows the server through commit, undo and redo by applying patches', () => {
    const server = editor();
    let s: LiveState = { ...base(), sequence: server.state, revision: server.revision };
    const feed = (kind: 'commit' | 'undo' | 'redo', patches: unknown[]) => {
      s = { ...s, ...applyServerEvent(s, { type: 'sequence', kind, revision: server.revision, patches: patches as never }) };
    };
    const tx1 = addClip(server, 0)!;
    feed('commit', tx1.patches);
    const tx2 = addClip(server, 48000 * 3)!;
    feed('commit', tx2.patches);
    server.undo();
    feed('undo', tx2.inverse);
    server.redo();
    feed('redo', tx2.patches);
    expect(s.sequence).toEqual(server.state);
    expect(s.revision).toBe(4);
    expect(s.sequenceStale).toBe(false);
  });

  it('a load event replaces the sequence; a skipped revision marks the mirror stale instead of diverging', () => {
    const server = editor();
    const tx = addClip(server, 0)!;
    let s: LiveState = { ...base(), sequence: createSequence({ width: 1, height: 1, fps: { num: 30, den: 1 } }), revision: 9 };
    s = { ...s, ...applyServerEvent(s, { type: 'sequence', kind: 'load', revision: 12, patches: [], sequence: server.state }) };
    expect(s).toMatchObject({ revision: 12, sequenceStale: false });
    expect(s.sequence).toEqual(server.state);
    // revision 14 arrives while we are at 12 → we missed 13
    const gap = applyServerEvent(s, { type: 'sequence', kind: 'commit', revision: 14, patches: tx.patches as never });
    expect(gap).toEqual({ sequenceStale: true });
    expect(applyServerEvent({ ...base(), sequence: null }, { type: 'sequence', kind: 'commit', revision: 1, patches: [] })).toEqual({ sequenceStale: true });
  });

  it('stores history updates', () => {
    const h = { canUndo: true, canRedo: false, undo: [], redo: [], snapshots: [] };
    expect(applyServerEvent(base(), { type: 'history', history: h })).toEqual({ history: h });
  });
});
