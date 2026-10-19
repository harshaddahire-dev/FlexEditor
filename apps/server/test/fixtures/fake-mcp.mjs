// A tiny MCP server over stdio (newline-delimited JSON-RPC) for tests: tools echo, add, fail, whoami (reads env).
import readline from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'whoami', description: 'Returns the TOKEN env var', inputSchema: { type: 'object', properties: {} } },
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
console.log('this line is not JSON-RPC and must be ignored');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  const ok = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
    case 'tools/list':
      return ok({ tools });
    case 'tools/call': {
      const { name, arguments: a } = msg.params;
      if (name === 'echo') return ok({ content: [{ type: 'text', text: `echo:${a.text}` }] });
      if (name === 'add') return ok({ content: [{ type: 'text', text: String(a.a + a.b) }], structuredContent: { sum: a.a + a.b } });
      if (name === 'whoami') return ok({ content: [{ type: 'text', text: process.env.TOKEN ?? '' }] });
      if (name === 'fail') return ok({ isError: true, content: [{ type: 'text', text: 'it broke' }] });
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no tool ${name}` } });
    }
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
