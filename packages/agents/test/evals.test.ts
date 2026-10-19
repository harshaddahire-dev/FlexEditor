import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../evals/scenarios';
import { formatResults, runScenario } from '../evals/harness';

describe('agent evals (scripted trajectories)', () => {
  it('every scenario is achievable with the real tools and passes its checks', async () => {
    const results = [];
    for (const s of SCENARIOS) results.push(await runScenario(s, 'scripted'));
    // eslint-disable-next-line no-console
    console.log('\n' + formatResults(results));
    for (const r of results) expect(r.checks.filter((c) => !c.ok), `${r.id}: ${r.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail ?? ''}`).join('; ')}`).toEqual([]);
    expect(results).toHaveLength(SCENARIOS.length);
  });

  it('the checks actually fail when the agent does the wrong thing (negative controls)', async () => {
    const by = (id: string) => SCENARIOS.find((s) => s.id === id)!;
    // an agent that only talks never removes the silence
    const idle = await runScenario({ ...by('remove-silence'), script: [() => ({ text: 'Done!' })] }, 'scripted');
    expect(idle.passed).toBe(false);
    expect(idle.checks.find((c) => c.name.startsWith('the silence is gone'))!.ok).toBe(false);
    // cutting the wrong stretch (speech instead of silence) is caught
    const wrong = await runScenario({ ...by('remove-silence'), script: [() => ({ calls: [{ name: 'remove_range', args: { from: 0.5, to: 2.8 } }] }), () => ({ text: 'Done.' })] }, 'scripted');
    expect(wrong.passed).toBe(false);
    // editing when asked a question is caught
    const eager = await runScenario({ ...by('question-no-edit'), script: (h) => [() => ({ calls: [{ name: 'delete_clips', args: { clipIds: [h.sequence().tracks.find((t) => t.name === 'V1')!.items && Object.keys(h.sequence().tracks.find((t) => t.name === 'V1')!.items)[0]!] } }] }), () => ({ text: 'It is 9 seconds.' })] }, 'scripted');
    expect(eager.checks.find((c) => c.name === 'made no edits')!.ok).toBe(false);
    // a skill command answered without loading the skill is caught
    const lazy = await runScenario({ ...by('use-a-skill'), script: [() => ({ text: 'No chapters here.' })] }, 'scripted');
    expect(lazy.passed).toBe(false);
  });
});
