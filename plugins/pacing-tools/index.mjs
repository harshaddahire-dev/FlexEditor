// Example Cutroom plugin. A plugin is an ES module whose default export describes its tools (and optionally skills).
// Tools get a context with the current sequence/media and an applyOps() that goes through the same validated,
// undoable engine as every other edit. Plain JSON Schema is enough; zod (via @cutroom/plugin-sdk) is optional.

// Track items are an id → item map; only video clips count for pacing (audio is linked to them).
const clipsOf = (ctx) =>
  ctx
    .sequence()
    .tracks.filter((t) => t.kind === 'video')
    .flatMap((t) => Object.values(t.items))
    .filter((i) => i.kind === 'clip');

export default {
  id: 'pacing-tools',
  name: 'Pacing tools',
  version: '1.0.0',
  tools: [
    {
      name: 'pacing_report',
      description: 'Number of clips and how long they are (average, median, shortest, longest) — a quick read on how fast the edit feels.',
      parameters: { type: 'object', properties: {} },
      run: (ctx) => {
        const rate = ctx.sequence().timebase.rate;
        const lens = clipsOf(ctx)
          .map((c) => c.duration / rate)
          .sort((a, b) => a - b);
        if (!lens.length) return { clips: 0 };
        const sum = lens.reduce((a, b) => a + b, 0);
        const r = (x) => Math.round(x * 100) / 100;
        return { clips: lens.length, averageSeconds: r(sum / lens.length), medianSeconds: r(lens[Math.floor(lens.length / 2)]), shortestSeconds: r(lens[0]), longestSeconds: r(lens[lens.length - 1]) };
      },
    },
  ],
  skills: [
    {
      name: 'pacing-check',
      description: 'Review the pace of the edit and flag stretches that drag.',
      body: 'Call pacing_report. If the average clip is longer than 8 s for talking-head material (or 4 s for b-roll) say the edit is slow and name the longest clips with get_sequence. Do not edit unless the user asks.',
    },
  ],
};
