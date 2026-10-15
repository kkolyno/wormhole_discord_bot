'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setupProcessHandlers } = require('../../src/events/errors');
const quiet = { info() {}, error() {} };
function setup(callbacks, options = {}) {
  const proc = new EventEmitter(), calls = [];
  proc.exit = code => calls.push(['exit', code]);
  const client = { async destroy() { calls.push('destroy'); } };
  const handlers = setupProcessHandlers(client, callbacks, { processImpl: proc, logger: quiet, deadlineMs: 100, ...options });
  return { proc, calls, client, ...handlers };
}
test('awaits async checkpoint/release before destroy; duplicate signals share shutdown', async () => {
  let resolve;
  const h = setup([() => new Promise(done => { resolve = done; })]);
  const shutdown = h.shutdown('SIGTERM');
  await Promise.resolve(); assert.deepEqual(h.calls, []);
  assert.equal(h.shutdown('SIGINT'), shutdown);
  resolve(); assert.equal(await shutdown, 0);
  assert.deepEqual(h.calls, ['destroy', ['exit', 0]]); h.dispose();
});
test('hung cleanup has a global deadline, destroys client, exits nonzero', async () => {
  const h = setup([() => new Promise(() => {})], { deadlineMs: 15 });
  const start = Date.now(); assert.equal(await h.shutdown('SIGTERM'), 1);
  assert.ok(Date.now() - start < 1000);
  assert.deepEqual(h.calls, ['destroy', ['exit', 1]]); h.dispose();
});
test('cleanup rejection is handled, remaining callbacks awaited, no private error logged', async () => {
  let finished = false;
  const h = setup([async () => { throw Error('PRIVATE'); }, async () => { finished = true; }]);
  assert.equal(await h.shutdown('SIGTERM'), 1); assert.equal(finished, true);
  assert.deepEqual(h.calls, ['destroy', ['exit', 1]]); h.dispose();
});
test('client destruction itself is bounded by the same deadline', async () => {
  const h = setup([], { deadlineMs: 10 }); h.client.destroy = () => new Promise(() => {});
  assert.equal(await h.shutdown('SIGTERM'), 1); assert.deepEqual(h.calls, [['exit', 1]]); h.dispose();
});
