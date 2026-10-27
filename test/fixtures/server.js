/**
 * Deterministic fake MCP server used by the test suite.
 * Behaviour is selected by the tool name in `tools/call`.
 */
import { createInterface } from 'node:readline';

const calls = new Map();
const notifications = [];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

let inFlight = 0;
let maxInFlight = 0;

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.method === undefined) return;

  if (message.id === undefined) {
    notifications.push(message.method);
    return;
  }

  if (message.method === 'initialize') {
    return reply(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'fixture', version: '1.0.0' },
    });
  }

  if (message.method === 'tools/list') {
    return reply(message.id, {
      tools: ['echo', 'slow', 'ratelimit', 'never', 'stats'].map((name) => ({ name, inputSchema: { type: 'object' } })),
    });
  }

  if (message.method !== 'tools/call') return reply(message.id, { ok: true });

  const name = message.params?.name;
  const attempt = (calls.get(name) ?? 0) + 1;
  calls.set(name, attempt);
  const startedAt = Date.now();

  if (name === 'never') return undefined;

  if (name === 'ratelimit') {
    if (attempt === 1) {
      return reply(message.id, { isError: true, content: [{ type: 'text', text: 'Error: Rate limit exceeded' }] });
    }
    return reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ attempt, startedAt }) }] });
  }

  if (name === 'slow') {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return setTimeout(() => {
      inFlight -= 1;
      reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ startedAt, finishedAt: Date.now(), maxInFlight }) }] });
    }, 120);
  }

  if (name === 'stats') {
    return reply(message.id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            calls: Object.fromEntries(calls),
            notifications: notifications.length,
            maxInFlight,
          }),
        },
      ],
    });
  }

  // echo
  return reply(message.id, {
    content: [{ type: 'text', text: JSON.stringify({ attempt, startedAt, args: message.params?.arguments ?? null }) }],
  });
});
