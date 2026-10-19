/**
 * Run the agent evals against a real model.
 *
 *   EVAL_PROVIDER=openrouter EVAL_API_KEY=sk-… EVAL_MODEL=anthropic/claude-sonnet-4.5 pnpm eval:live
 *   EVAL_PROVIDER=custom EVAL_BASE_URL=http://localhost:11434/v1 EVAL_MODEL=llama3.1 pnpm eval:live     # Ollama, no key
 *   pnpm eval:live remove-silence highlight-30s            # only these scenarios
 *
 * Providers: openrouter | openai | anthropic | gemini | custom. The scenarios use the synthetic project of the scripted
 * suite, and the checks judge the result on the timeline (not the path the model took).
 */
import { PROVIDER_PRESETS, type Effort, type ProviderKind } from '@cutroom/core';
import { formatResults, runScenario } from '../../../packages/agents/evals/harness';
import { SCENARIOS } from '../../../packages/agents/evals/scenarios';
import { chatStream } from '../src/providers/llm';

const kind = (process.env.EVAL_PROVIDER ?? 'openrouter') as ProviderKind;
const preset = PROVIDER_PRESETS[kind];
if (!preset) {
  console.error(`Unknown EVAL_PROVIDER "${kind}". Use one of: ${Object.keys(PROVIDER_PRESETS).join(', ')}.`);
  process.exit(2);
}
const model = process.env.EVAL_MODEL;
if (!model) {
  console.error('Set EVAL_MODEL (for example anthropic/claude-sonnet-4.5 on OpenRouter).');
  process.exit(2);
}
const apiKey = process.env.EVAL_API_KEY;
if (!apiKey && kind !== 'custom') {
  console.error('Set EVAL_API_KEY.');
  process.exit(2);
}
const conn = { kind, baseUrl: process.env.EVAL_BASE_URL ?? preset.baseUrl, ...(apiKey ? { key: apiKey } : {}) };
const effort = (process.env.EVAL_EFFORT ?? 'medium') as Effort;
const only = process.argv.slice(2);

const llm = {
  stream: (req: Parameters<typeof chatStream>[1], signal?: AbortSignal) => chatStream(conn, { ...req, model, effort }, signal),
};

const chosen = SCENARIOS.filter((s) => !only.length || only.includes(s.id));
if (!chosen.length) {
  console.error(`No scenario matches. Available: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(2);
}
console.log(`Evaluating ${model} via ${kind} on ${chosen.length} scenario(s)…\n`);
const results = [];
for (const s of chosen) {
  process.stdout.write(`· ${s.id} … `);
  const r = await runScenario(s, llm, { maxSteps: 25 }).catch((e: Error) => ({ id: s.id, title: s.title, passed: false, checks: [{ name: 'ran', ok: false, detail: e.message }], tools: [], edits: 0, steps: 0, ms: 0, summary: '' }));
  console.log(r.passed ? 'pass' : 'FAIL');
  results.push(r);
}
console.log('\n' + formatResults(results));
process.exit(results.every((r) => r.passed) ? 0 : 1);
