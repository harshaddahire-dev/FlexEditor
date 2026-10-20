import http from 'node:http';

export type Step = { text?: string; calls?: { name: string; args: unknown }[] };

/** An OpenAI-compatible endpoint whose "model" follows a script, one step per assistant round-trip (stand-in for a real provider). */
export async function fakeModel(steps: Step[]): Promise<{ baseUrl: string; close(): Promise<void>; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/models') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'script-1', context_length: 128000 }] }));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { role: string }[] };
      requests.push(body);
      const round = body.messages.filter((m) => m.role === 'assistant').length;
      const step = steps[Math.min(round, steps.length - 1)]!;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (step.text) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: step.text } }] })}\n\n`);
      (step.calls ?? []).forEach((c, i) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${round}_${i}`, function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] })}\n\n`));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1200 + round * 300, completion_tokens: 60 } })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
