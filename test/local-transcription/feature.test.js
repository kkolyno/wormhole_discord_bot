'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Events } = require('discord.js');
const { createFeature, voiceSnapshot, createTransport, statusText } = require('../../src/features/local-transcription');
const { loadConfig } = require('../../src/features/local-transcription/config');
const ids = { guild: '111111111111111111', voice: '222222222222222222', alerts: '333333333333333333', human: '444444444444444444', bot: '555555555555555555', notice: '666666666666666666' };
const cfg = loadConfig({ GUILD_ID: ids.guild, VOICE_CHANNEL_ID: ids.voice, ALERTS_CHANNEL_ID: ids.alerts, LOCAL_TRANSCRIPTION_DATA_DIR: '/tmp/transcription-fake' });
function harness(t, { lockAcquire = async () => {} } = {}) {
  const calls = [], notices = [{ phase: 'active', notice: { state: 'sent', id: ids.notice } }];
  const channel = { guild: { id: ids.guild }, isVoiceBased: () => true, members: new Map([[ids.human, { id: ids.human, displayName: 'Synthetic', user: { bot: false } }]]) };
  const guild = { available: true, channels: { cache: new Map([[ids.voice, channel]]), fetch: async () => channel } };
  const client = { user: { id: ids.bot }, rest: { options: {} }, guilds: { cache: new Map([[ids.guild, guild]]), fetch: async () => guild } };
  let lock, coord;
  class Lock {
    constructor(options) { this.options = options; lock = this; }
    async acquire() { calls.push('lock'); await lockAcquire(); this.acquired = true; }
    async release() { calls.push('release'); this.acquired = false; }
  }
  class Store { listSessions() { return notices; } }
  class Audio { async open() { return { close: async () => calls.push('capture-close') }; } }
  class Publisher { constructor(options) { calls.push(['publisher', options.allowAttachments]); } }
  class Coordinator {
    constructor(options) { this.options = options; coord = this; }
    async init() { calls.push('recover'); }
    async membership(members) { calls.push(['membership', members]); }
    invalidate(id) { calls.push(['invalidate', id]); }
    async consent(...args) { calls.push(['consent', ...args]); }
    async revoke(...args) { calls.push(['revoke', ...args]); }
    async end(...args) { calls.push(['end', ...args]); }
    async fault(code) { calls.push(['fault', code]); }
    async tick() {}
    async shutdown() { calls.push('shutdown'); }
    status() { return { initialized: true, recording: false, consenting: 0, occupancy: 1, pendingJobs: 2, draining: 0, incomplete: 0, held: 0, holdUntilEmpty: false, failed: false, issue: null, text: 'PRIVATE TEXT' }; }
  }
  const feature = createFeature({ config: cfg, Store, Audio, Publisher, Coordinator, WriterLock: Lock, recognize: async () => '' });
  t.after(() => feature.cleanup());
  const event = name => feature.events.find(event => event.name === name).execute;
  const interaction = extra => ({ guildId: ids.guild, channelId: ids.alerts, user: { id: ids.human, bot: false }, message: { id: ids.notice, author: { id: ids.bot } },
    async reply(payload) { calls.push(['reply', payload]); }, async deferReply() { this.deferred = true; calls.push('defer'); }, async editReply(payload) { calls.push(['edit', payload]); }, ...extra });
  return { feature, calls, channel, client, interaction, event, get lock() { return lock; }, get coord() { return coord; } };
}
test('root strictly selects one owner and does not eagerly load legacy', () => {
  const source = fs.readFileSync(require.resolve('../../index.js'), 'utf8');
  assert.match(source, /process\.env\.LOCAL_TRANSCRIPTION_ENABLED === 'true'/);
  assert.match(source, /\? require\('\.\/src\/features\/local-transcription'\)\s*:\s*require\('\.\/src\/features\/meetings'\)/);
});
test('root runtime selects exactly one feature for every strict flag value (fake client, no login)', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../index.js'), 'utf8');
  for (const value of [undefined, 'false', 'TRUE', '1', 'true']) {
    const selected = [];
    const noop = () => {};
    const fakeRequire = name => {
      if (name.startsWith('./src/features/')) { selected.push(name); return {}; }
      if (name === './src/core/client') return { createClient: () => ({ login: () => Promise.resolve() }) };
      if (name === './src/core/config') return { CONFIG: {}, validateConfig: noop };
      if (name === './src/core/logger') return { logger: { setClient: noop } };
      if (name === './src/utils/discord') return { setClient: noop };
      if (name === './src/commands') return { globalCommands: [] };
      if (name === './src/events') return { globalEvents: [], setupProcessHandlers: noop };
      if (name === './src/core/registry') return new Proxy({}, { get: () => noop });
      throw Error('UNEXPECTED_ROOT_IMPORT');
    };
    vm.runInNewContext(source, { require: fakeRequire, process: { env: { LOCAL_TRANSCRIPTION_ENABLED: value } }, console: { log: noop } });
    assert.deepEqual(selected, [value === 'true' ? './src/features/local-transcription' : './src/features/meetings']);
  }
});
test('lock precedes recovery; recovery precedes membership; attachments stay unapproved', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  assert.ok(h.calls.indexOf('lock') < h.calls.indexOf('recover'));
  assert.ok(h.calls.indexOf('recover') < h.calls.findIndex(call => call[0] === 'membership'));
  assert.deepEqual(h.calls.find(call => call[0] === 'publisher'), ['publisher', false]);
  assert.equal(h.client.rest.options.retries, 0);
});
test('shutdown during startup cannot create a store/coordinator after releasing the lock', async t => {
  const h = harness(t);
  const startup = h.feature.onStartup(h.client);
  const cleanup = h.feature.cleanup();
  await Promise.all([startup, cleanup]);
  assert.ok(h.calls.includes('release'));
  assert.ok(!h.calls.includes('recover'));
  assert.equal(h.calls.filter(call => call[0] === 'membership').length, 0);
});
test('only exact current bot-authored notice and present human may use static IDs', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  assert.deepEqual(Object.keys(h.feature.buttonHandlers).sort(), ['local_transcription_consent', 'local_transcription_end', 'local_transcription_revoke']);
  const handler = h.feature.buttonHandlers.local_transcription_consent;
  for (const extra of [{ guildId: '999999999999999999' }, { channelId: ids.voice }, { user: { id: ids.human, bot: true } },
    { message: { id: '777777777777777777', author: { id: ids.bot } } }, { message: { id: ids.notice, author: { id: ids.human } } }]) await handler(h.interaction(extra));
  assert.equal(h.calls.filter(call => call[0] === 'consent').length, 0);
  await handler(h.interaction()); assert.deepEqual(h.calls.find(call => call[0] === 'consent'), ['consent', ids.human, ids.notice]);
  h.channel.members.clear(); await handler(h.interaction());
  assert.equal(h.calls.filter(call => call[0] === 'consent').length, 1);
});
test('leave immediately invalidates before blocked snapshot, revoke before acknowledgement', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  const before = h.calls.length;
  const promise = h.event(Events.VoiceStateUpdate)({ id: ids.human, channelId: ids.voice, guild: { id: ids.guild } }, { id: ids.human, channelId: null, guild: { id: ids.guild } });
  assert.deepEqual(h.calls[before], ['invalidate', ids.human]); await promise;
  await h.feature.buttonHandlers.local_transcription_revoke(h.interaction());
  const defer = h.calls.lastIndexOf('defer'); assert.deepEqual(h.calls[defer - 1], ['invalidate', ids.human]);
});
test('authenticated revoke removes the gate before even a stalled membership request', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  let release;
  h.client.guilds.fetch = () => new Promise(resolve => { release = resolve; });
  const before = h.calls.length;
  const action = h.feature.buttonHandlers.local_transcription_revoke(h.interaction());
  assert.deepEqual(h.calls[before], ['invalidate', ids.human]);
  release(null); await action;
});
test('membership changes during consent acknowledgement cannot restore consent', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  const interaction = h.interaction({ async deferReply() {
    this.deferred = true;
    h.channel.members.clear();
    await h.event(Events.VoiceStateUpdate)({ id: ids.human, channelId: ids.voice, guild: { id: ids.guild } }, { id: ids.human, channelId: null, guild: { id: ids.guild } });
  } });
  await h.feature.buttonHandlers.local_transcription_consent(interaction);
  assert.equal(h.calls.filter(call => call[0] === 'consent').length, 0);
});
test('unknown occupancy stays null and gateway interruption invalidates synchronously', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  h.client.guilds.fetch = async () => { throw Error('PRIVATE ERROR'); };
  assert.equal(await voiceSnapshot(h.client, cfg), null);
  const before = h.calls.length, result = h.event(Events.ShardDisconnect)();
  assert.deepEqual(h.calls[before], ['invalidate', ids.human]); await result;
  assert.ok(h.calls.some(call => call[0] === 'membership' && call[1] === null));
});
test('periodic membership retry recovers a transient fetch failure without another voice event and is single-flight', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
  const h = harness(t); await h.feature.onStartup(h.client);
  const guild = await h.client.guilds.fetch(ids.guild);
  guild.channels.fetch = async () => { throw Error('PRIVATE_FETCH_FAILURE'); };
  await h.event(Events.VoiceStateUpdate)({ id: ids.human, channelId: ids.voice, guild: { id: ids.guild } }, { id: ids.human, channelId: null, guild: { id: ids.guild } });
  assert.equal(h.calls.filter(call => call[0] === 'membership').at(-1)[1], null);
  h.channel.members.clear(); let finish, requests = 0;
  guild.channels.fetch = () => { requests++; return new Promise(resolve => { finish = () => resolve(h.channel); }); };
  t.mock.timers.tick(5250); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5250); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1, 'overlapping polling requests were queued');
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.filter(call => call[0] === 'membership').at(-1)[1], []);
  await h.feature.cleanup();
});

test('normal cleanup leaves gates to coordinator EOF/drain, blocks new buttons immediately and releases last', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  await h.coord.options.audio.open({});
  let drained;
  h.coord.shutdown = async () => { h.calls.push('shutdown'); await new Promise(resolve => { drained = resolve; }); h.calls.push('drained'); };
  const before = h.calls.length;
  const cleanup = h.feature.cleanup();
  await h.feature.buttonHandlers.local_transcription_consent(h.interaction());
  assert.equal(h.calls.filter(call => call[0] === 'consent').length, 0);
  assert.equal(h.calls.slice(before).filter(call => call[0] === 'invalidate').length, 0);
  assert.ok(h.calls.includes('shutdown'));
  assert.ok(!h.calls.includes('release')); assert.ok(!h.calls.includes('capture-close'));
  drained(); await cleanup;
  assert.ok(h.calls.indexOf('drained') < h.calls.indexOf('capture-close'));
  assert.ok(h.calls.indexOf('capture-close') < h.calls.indexOf('release'));
});
test('feature failure retains immediate revocation, capture close and native shutdown', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  await h.coord.options.audio.open({});
  h.coord.membership = async () => { throw Error('PRIVATE'); };
  await h.event(Events.VoiceStateUpdate)({ id: ids.human, channelId: ids.voice, guild: { id: ids.guild } }, { id: ids.human, channelId: ids.voice, guild: { id: ids.guild } });
  assert.ok(h.calls.some(call => call[0] === 'invalidate' && call[1] === ids.human));
  assert.ok(h.calls.includes('capture-close')); assert.ok(h.calls.includes('shutdown'));
  await h.feature.buttonHandlers.local_transcription_consent(h.interaction());
  assert.equal(h.calls.filter(call => call[0] === 'consent').length, 0);
  await h.feature.cleanup();
  assert.ok(h.calls.indexOf('shutdown') < h.calls.indexOf('release'));
});
for (const resumed of [false, true]) test(`gateway ${resumed ? 'resumed' : 'disconnected'} during lock acquire never loses availability state`, async t => {
  let unlock;
  const h = harness(t, { lockAcquire: () => new Promise(resolve => { unlock = resolve; }) });
  const startup = h.feature.onStartup(h.client);
  let fetches = 0;
  const fetch = h.client.guilds.fetch;
  h.client.guilds.fetch = (...args) => { fetches++; return fetch(...args); };
  await h.event(Events.ShardDisconnect)();
  if (resumed) await h.event(Events.ShardResume)();
  unlock(); await startup;
  const memberships = h.calls.filter(call => call[0] === 'membership');
  assert.ok(memberships.length > 0);
  if (resumed) {
    assert.equal(memberships.at(-1)[1][0].id, ids.human);
    assert.equal(fetches, 1);
    await h.feature.buttonHandlers.local_transcription_consent(h.interaction());
    assert.equal(h.calls.filter(call => call[0] === 'consent').length, 1);
  } else {
    assert.equal(memberships.at(-1)[1], null);
    assert.equal(fetches, 0); // populated cache is NOT known while disconnected
    await h.feature.buttonHandlers.local_transcription_end(h.interaction());
    assert.equal(h.calls.filter(call => call[0] === 'end').length, 0);
  }
});
test('end synchronously cuts off all observed gates and invokes core before any HTTP', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  let fetches = 0, acknowledge;
  h.client.guilds.fetch = () => { fetches++; return new Promise(() => {}); };
  const before = h.calls.length;
  const action = h.feature.buttonHandlers.local_transcription_end(h.interaction({
    deferReply() { h.calls.push('defer'); return new Promise(resolve => { acknowledge = resolve; }); },
  }));
  assert.deepEqual(h.calls.slice(before), [['invalidate', ids.human], ['end', ids.notice], 'defer']);
  assert.equal(fetches, 0);
  acknowledge(); await action;
});
test('end still rejects stale/cross-guild/foreign notices and absent or bot cache members', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  const before = h.calls.length;
  for (const extra of [{ guildId: ids.voice }, { channelId: ids.voice },
    { message: { id: ids.notice, author: { id: ids.human } } },
    { message: { id: '777777777777777777', author: { id: ids.bot } } }, { user: { id: ids.human, bot: true } }]) {
    await h.feature.buttonHandlers.local_transcription_end(h.interaction(extra));
  }
  h.channel.members.clear(); await h.feature.buttonHandlers.local_transcription_end(h.interaction());
  h.channel.members.set(ids.human, { id: ids.human, user: { bot: true } });
  await h.feature.buttonHandlers.local_transcription_end(h.interaction());
  assert.equal(h.calls.slice(before).filter(call => ['invalidate', 'end'].includes(call[0])).length, 0);
});
test('grant consent still waits for a fresh known membership snapshot', async t => {
  const h = harness(t); await h.feature.onStartup(h.client);
  let fetched;
  h.client.guilds.fetch = () => new Promise(resolve => { fetched = resolve; });
  const action = h.feature.buttonHandlers.local_transcription_consent(h.interaction());
  assert.equal(h.calls.filter(call => call[0] === 'consent').length, 0);
  fetched(null); await action;
  assert.equal(h.calls.filter(call => call[0] === 'consent').length, 0);
});
test('status renders the real coordinator fields, with numeric incomplete and no invented publication state', () => {
  const status = { initialized: true, recording: true, consenting: 2, occupancy: 3, pendingJobs: 4, draining: 5,
    incomplete: 6, held: 7, holdUntilEmpty: true, failed: false, issue: 'CONSENT_LIMIT', text: 'PRIVATE', error: 'PRIVATE' };
  const output = statusText(status, 'idle');
  assert.ok(output.length < 1000); assert.doesNotMatch(output, /PRIVATE|idle|publication: unknown/);
  for (const expected of ['recording: yes', 'consenting: 2', 'occupancy: 3', 'Queue: 4', 'draining: 5',
    'incomplete: 6', 'held/uncertain: 7', 'Hold until empty: yes', 'failed: no', 'issue: CONSENT_LIMIT']) assert.ok(output.includes(expected), expected);
  const empty = statusText({ ...status, recording: false, consenting: 0, occupancy: 'unknown', pendingJobs: 0,
    draining: 0, incomplete: 0, held: 0, holdUntilEmpty: false, failed: true, issue: null });
  for (const expected of ['faulted', 'recording: no', 'consenting: 0', 'occupancy: unknown', 'incomplete: 0', 'held/uncertain: 0', 'Hold until empty: no', 'failed: yes', 'issue: none']) assert.ok(empty.includes(expected), expected);
  const hostile = statusText({ recording: 'PRIVATE', occupancy: 'PRIVATE', issue: 'PRIVATE', pendingJobs: 'PRIVATE', phase: 'PRIVATE', publication: { state: 'PRIVATE' } }, 'PRIVATE');
  assert.doesNotMatch(hostile, /PRIVATE/); assert.match(hostile, /details withheld/);
});
test('REST transport is bounded, no retries/pings, handles files, and sanitizes errors', async () => {
  const calls = [], client = { user: { id: ids.bot }, rest: { options: {}, async post(route, options) { calls.push(options); return { id: ids.notice }; }, async get(route, options) { calls.push(options); return []; }, async patch() { throw Error('PRIVATE TOKEN'); } } };
  const transport = createTransport(client, cfg);
  assert.deepEqual(await transport.send({ content: 'synthetic', nonce: '123', enforceNonce: true, files: [{ attachment: Buffer.from('synthetic'), name: 'transcript.txt' }], allowedMentions: { parse: ['everyone'] } }), { id: ids.notice });
  assert.equal(calls[0].body.enforce_nonce, true); assert.deepEqual(calls[0].body.allowed_mentions.parse, []);
  assert.ok(calls[0].signal instanceof AbortSignal); assert.equal(calls[0].files[0].name, 'transcript.txt');
  await transport.history({ limit: 100000 }); assert.equal(calls[1].query.get('limit'), '100');
  await assert.rejects(transport.edit(ids.notice, { content: 'synthetic' }), { message: 'TRANSCRIPTION_TRANSPORT_FAILED' });
  client.rest.post = () => new Promise(() => {});
  await assert.rejects(createTransport(client, { ...cfg, restTimeoutMs: 10 }).send({ content: 'synthetic' }), { message: 'TRANSCRIPTION_TRANSPORT_FAILED' });
});
