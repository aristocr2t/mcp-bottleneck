import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, merge } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { Proxy } from '../src/proxy.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'server.js');

function harness(overrides = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const proxy = new Proxy({
    command: process.execPath,
    args: [FIXTURE],
    config: merge(DEFAULTS, overrides),
    logger: createLogger('silent'),
    input,
    output,
  });

  const responses = new Map();
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined) responses.set(message.id, message);
    }
  });

  proxy.start();

  const send = (message) => input.write(`${JSON.stringify(message)}\n`);
  const call = (id, name, args = {}) =>
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  const waitFor = (id, timeout = 5000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (responses.has(id)) {
          clearInterval(timer);
          resolve(responses.get(id));
        } else if (Date.now() - started > timeout) {
          clearInterval(timer);
          reject(new Error(`no response for id ${id}`));
        }
      }, 5);
    });

  const payload = (message) => JSON.parse(message.result.content[0].text);

  /** Handshake with the fixture so process start-up is not measured by the timing tests. */
  const ready = async () => {
    send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    });
    await waitFor('init');
  };

  return { proxy, input, output, send, call, waitFor, payload, ready };
}

test('spaces throttled calls by at least the interval', async (t) => {
  const h = harness({ groups: { 'tools/call': { interval: 100 } } });
  t.after(() => h.proxy.shutdown());
  await h.ready();

  h.call(1, 'echo');
  h.call(2, 'echo');
  h.call(3, 'echo');

  const startedAt = (await Promise.all([1, 2, 3].map((id) => h.waitFor(id)))).map((m) => h.payload(m).startedAt);

  assert.ok(startedAt[1] - startedAt[0] >= 95, `gap 1->2 was ${startedAt[1] - startedAt[0]}ms`);
  assert.ok(startedAt[2] - startedAt[1] >= 95, `gap 2->3 was ${startedAt[2] - startedAt[1]}ms`);
});

test('runs calls in parallel when no limits are configured', async (t) => {
  const h = harness();
  t.after(() => h.proxy.shutdown());

  h.call(1, 'slow');
  h.call(2, 'slow');

  const [first, second] = await Promise.all([h.waitFor(1), h.waitFor(2)]);
  assert.equal(h.payload(first).maxInFlight, 2);
  assert.equal(h.payload(second).maxInFlight, 2);
});

test('honours the concurrency limit', async (t) => {
  const h = harness({ groups: { 'tools/call': { concurrency: 1 } } });
  t.after(() => h.proxy.shutdown());
  await h.ready();

  h.call(1, 'slow');
  h.call(2, 'slow');

  const first = h.payload(await h.waitFor(1));
  const second = h.payload(await h.waitFor(2));

  assert.equal(first.maxInFlight, 1);
  assert.ok(second.startedAt >= first.finishedAt - 5, 'second call started before the first finished');
});

test('coalesces identical in-flight calls into one upstream request', async (t) => {
  const h = harness({ coalesce: true });
  t.after(() => h.proxy.shutdown());

  h.call(1, 'echo', { query: 'same' });
  h.call(2, 'echo', { query: 'same' });

  const [first, second] = await Promise.all([h.waitFor(1), h.waitFor(2)]);

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.deepEqual(h.payload(first), h.payload(second), 'both clients must get the same upstream answer');

  h.call(3, 'stats');
  assert.equal(h.payload(await h.waitFor(3)).calls.echo, 1, 'upstream must have been called once');
});

test('retries rate-limit errors and hides them from the client', async (t) => {
  const h = harness({ retries: 2, retryBaseMs: 10, groups: { 'tools/call': { interval: 0 } } });
  t.after(() => h.proxy.shutdown());

  h.call(1, 'ratelimit');
  const response = await h.waitFor(1);

  assert.equal(response.result.isError, undefined, 'client must not see the rate-limit error');
  assert.equal(h.payload(response).attempt, 2, 'second attempt should have succeeded');
});

test('gives up after the configured number of retries', async (t) => {
  const h = harness({ retries: 0 });
  t.after(() => h.proxy.shutdown());

  h.call(1, 'ratelimit');
  const response = await h.waitFor(1);

  assert.equal(response.result.isError, true, 'without retries the error is passed through');
});

test('answers with a JSON-RPC error when the server stays silent', async (t) => {
  const h = harness({ timeout: 80 });
  t.after(() => h.proxy.shutdown());

  h.call(1, 'never');
  const response = await h.waitFor(1);

  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /no response after 80ms/);
});

test('forwards notifications and non-JSON lines untouched', async (t) => {
  const h = harness();
  t.after(() => h.proxy.shutdown());

  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.call(1, 'stats');
  assert.equal(h.payload(await h.waitFor(1)).notifications, 1);
});

test('frees the queue slot when the client cancels', async (t) => {
  const h = harness({ groups: { 'tools/call': { concurrency: 1 } }, timeout: 10_000 });
  t.after(() => h.proxy.shutdown());
  await h.ready();

  h.call(1, 'never');
  await new Promise((resolve) => setTimeout(resolve, 30));
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 30));

  // With the slot freed, this call must be dispatched instead of waiting behind id 1.
  h.call(2, 'echo');
  const response = await h.waitFor(2, 1000);
  assert.equal(response.result.isError, undefined);
  assert.equal(h.proxy.pending.size, 0, 'cancelled request must not stay pending');
  assert.equal(h.proxy.timers.size, 0, 'cancelled request must not leave its timeout armed');
});

test('cancels a queued request before it reaches the server', async (t) => {
  const h = harness({ groups: { 'tools/call': { concurrency: 1 } } });
  t.after(() => h.proxy.shutdown());

  h.call(1, 'slow'); // grabs the only concurrency slot for ~120ms
  await new Promise((resolve) => setTimeout(resolve, 40)); // id 1 is now in flight
  h.call(2, 'echo'); // queued behind id 1
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });

  await h.waitFor(1); // wait until the slot frees

  h.call(3, 'stats');
  const stats = h.payload(await h.waitFor(3));
  assert.equal(stats.calls.echo, undefined, 'queued request must not be dispatched after cancellation');
  assert.equal(h.proxy.entries.size, 0, 'no live entries must remain');
});

test('rejects requests beyond the pending limit', async (t) => {
  const h = harness({ maxPending: 2, groups: { 'tools/call': { concurrency: 1 } } });
  t.after(() => h.proxy.shutdown());

  h.call(1, 'slow'); // in flight, holds the only slot
  h.call(2, 'echo'); // queued -> pending count reaches the cap
  h.call(3, 'echo'); // over the cap -> immediate JSON-RPC error

  const rejected = await h.waitFor(3);
  assert.equal(rejected.error.code, -32002);
  assert.match(rejected.error.message, /too many pending/);

  await h.waitFor(1);
  await h.waitFor(2);
});
