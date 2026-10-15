'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { REST } = require('discord.js');
const { restOptions, fetchTarget } = require('../probe');

function delayedRequest() {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const state = { calls: 0, aborted: false, ready };
  state.request = (_url, { signal }) => new Promise((resolve, reject) => {
    state.calls++; started();
    const cancel = () => { state.aborted = true; reject(signal.reason); };
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
  return state;
}

test('shutdown cancels actual REST HTTP boundary during guild fetch and never fetches channel', async () => {
  const shutdown = new AbortController(), network = delayedRequest();
  const options = restOptions(shutdown.signal, network.request);
  assert.equal(options.retries, 0); assert.equal(options.timeout, 3000);
  assert.equal(options.rejectOnRateLimit(), true);
  // Real pinned REST request machinery, fake transport only: no Discord connection.
  const rest = new REST(options).setToken('local-fake-not-used');
  let channelCalls = 0;
  const guild = { channels: { fetch: () => { channelCalls++; } } };
  const client = { guilds: { fetch: async () => { await rest.get('/guilds/111111111111111111'); return guild; } } };
  const fetching = fetchTarget(client, { guild: '111111111111111111', channel: '222222222222222222' }, shutdown.signal);
  await network.ready;
  shutdown.abort();
  await assert.rejects(fetching, { name: 'AbortError' });
  assert.equal(network.aborted, true); assert.equal(network.calls, 1); assert.equal(channelCalls, 0);
  await assert.rejects(rest.get('/channels/222222222222222222'), { name: 'AbortError' });
  assert.equal(network.calls, 1); // Aborted shutdown cannot initiate another HTTP request.
});

test('late guild resolution after shutdown cannot initiate channel fetch (including cache path)', async () => {
  const shutdown = new AbortController();
  let release, channels = 0;
  const guild = { channels: { fetch: () => { channels++; } } };
  const client = { guilds: { fetch: () => new Promise(resolve => { release = resolve; }) } };
  const fetching = fetchTarget(client, {}, shutdown.signal);
  shutdown.abort(); release(guild);
  await assert.rejects(fetching, { name: 'AbortError' });
  assert.equal(channels, 0);
});

test('REST transport deadline aborts a stalled request rather than merely racing its await', async () => {
  const network = delayedRequest();
  const rest = new REST(restOptions(new AbortController().signal, network.request)).setToken('local-fake-not-used');
  // Keep the event loop alive: AbortSignal.timeout itself uses an unref timer.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(rest.get('/guilds/111111111111111111'), error =>
      error.name === 'AbortError' || error.name === 'TimeoutError');
    assert.equal(network.aborted, true); assert.equal(network.calls, 1);
  } finally { clearTimeout(keepAlive); }
});
