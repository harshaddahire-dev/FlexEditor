import { describe, expect, it } from 'vitest';
import type { JobInfo, Media, ProjectSummary } from '@cutroom/core';
import { applyServerEvent, type LiveState } from '../src/store/events';

const summary: ProjectSummary = { id: 'p', name: 'P', folder: '/p', settings: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, sampleRate: 48000 }, mediaCount: 0, ignoredCount: 0 };
const media = (id: string): Media => ({ id, name: `${id}.mp4` }) as Media;
const job = (id: string, finishedAt?: number): JobInfo => ({ id, kind: 'proxy', label: id, state: finishedAt ? 'done' : 'running', progress: 0, createdAt: 0, finishedAt });
const base = (): LiveState => ({ project: summary, media: {}, jobs: {}, selectedMediaId: null, lastScan: null });

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
    expect(applyServerEvent(s, { type: 'project', project: null })).toEqual({ project: null, media: {}, selectedMediaId: null, lastScan: null });
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
