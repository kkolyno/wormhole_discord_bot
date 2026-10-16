'use strict';
// Actual feature/config/Store/Coordinator/Publisher/OS lock; only Discord, audio
// and inference are fake. No credentials, network, app login or private speech.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Events } = require('discord.js');
const { createFeature } = require('../../src/features/local-transcription');
const { loadConfig } = require('../../src/features/local-transcription/config');
const { Coordinator } = require('../../src/features/local-transcription/coordinator');
const A = '111111111111111111', B = '222222222222222222', BOT = '333333333333333333';
const GUILD = '444444444444444444', VOICE = '555555555555555555', ALERTS = '666666666666666666';
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(t, { mode = 'channel', accounts = [A], deferNotice = false, openReady, recognize, limits = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-integrated-'));
  let clock = 1000, serial = 0, core, feature, finishNotice;
  const handles = [], messages = [], members = new Map(), noticeAcks = [];
  const member = id => ({ id, displayName: id === A ? 'Synthetic A' : 'Synthetic B', user: { id, username: 'Synthetic', bot: false } });
  for (const id of accounts) members.set(id, member(id));
  const channel = { guild: { id: GUILD }, isVoiceBased: () => true, members };
  const guild = { available: true, channels: { cache: new Map([[VOICE, channel]]), fetch: async () => channel } };
  const client = { user: { id: BOT }, guilds: { cache: new Map([[GUILD, guild]]), fetch: async () => guild }, rest: { options: {},
    async post(route, options) {
      const row = { id: String(777777777777777770n + BigInt(++serial)), author: { id: BOT }, content: options.body.content, components: options.body.components, timestamp: new Date(clock).toISOString() };
      assert.ok(row.content.length <= 2000); messages.unshift(row);
      if (deferNotice && row.content.includes('local-notice:')) return new Promise(resolve => {
        noticeAcks.push(() => resolve({ id: row.id }));
        finishNotice = () => { for (const ack of noticeAcks.splice(0)) ack(); };
      });
      return { id: row.id };
    },
    async patch(route, options) { const row = messages.find(row => route.endsWith('/' + row.id)); if (row) { row.content = options.body.content; row.components = options.body.components; } return {}; },
    async get() { return messages; },
  } };
  class Audio {
    async open(callbacks) {
      const handle = { ...callbacks, allowed: new Set(), closed: false,
        async setConsented(id, value) { if (value) this.allowed.add(id); else this.allowed.delete(id); },
        emit(id) { return this.onPcm({ userId: id, pcm: Buffer.alloc(1920, 1), atMs: clock }); },
        async close() { this.closed = true; this.allowed.clear(); },
      }; handles.push(handle); if (openReady) await openReady(handle, handles.length); return handle;
    }
  }
  class Core extends Coordinator {
    constructor(options) { super({ ...options, now: () => clock, limits: { ...options.limits, quietMs: 10, emptyGraceMs: 20, ...limits } }); core = this; }
  }
  const config = loadConfig({ GUILD_ID: GUILD, VOICE_CHANNEL_ID: VOICE, ALERTS_CHANNEL_ID: ALERTS, LOCAL_TRANSCRIPTION_DATA_DIR: root, LOCAL_TRANSCRIPTION_CONSENT_MODE: mode });
  function create() { feature = createFeature({ config, Audio, Coordinator: Core, recognize: recognize || (async () => 'Synthetic automatic brain dump.') }); return feature; }
  create();
  t.after(async () => { finishNotice?.(); await feature.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  const interaction = (id, extra = {}) => ({ guildId: GUILD, channelId: ALERTS, user: { id, bot: false },
    message: { id: core.store.getSession(core.current.id).notice.id, author: { id: BOT } },
    async reply() {}, async deferReply() { this.deferred = true; }, async editReply() {}, ...extra });
  async function change(id, present) {
    if (present) members.set(id, member(id)); else members.delete(id);
    const event = feature.events.find(event => event.name === Events.VoiceStateUpdate);
    await event.execute({ id, guild: { id: GUILD }, channelId: present ? null : VOICE }, { id, guild: { id: GUILD }, channelId: present ? VOICE : null });
    await flush();
  }
  return { root, handles, messages, members, client, config, create, interaction, change, member,
    get feature() { return feature; }, get core() { return core; }, finishNotice: () => finishNotice?.(), time: n => { clock = n; } };
}
test('channel policy captures a lone brain dump before notice acknowledgement; canonical waits for end and jobs', async t => {
  const f = fixture(t, { deferNotice: true });
  await f.feature.onStartup(f.client); await flush();
  assert.equal(f.handles.length, 1); assert.equal(f.handles[0].allowed.has(A), true);
  const id = f.core.current.id; assert.equal(f.core.store.getSession(id).notice.state, 'sending');
  assert.equal(f.core.store.getSession(id).consentMode, 'channel');
  assert.equal(f.handles[0].emit(A), true); f.time(1100); await f.core.tick(); await flush();
  assert.equal(f.core.store.listJobs(id)[0].state, 'recognized');
  assert.equal(f.messages.filter(row => row.content.includes('local-final:')).length, 0);
  f.finishNotice(); await flush(); f.time(2000); await f.change(A, false); f.time(2021); await f.core.tick(); await flush();
  const final = f.messages.filter(row => row.content.includes('local-final:'));
  assert.equal(final.length, 1); assert.match(final[0].content, /Synthetic automatic brain dump/);
  assert.equal(f.core.store.getSession(id).phase, 'published');
});
test('channel policy never starts for a bots-only room', async t => {
  const f = fixture(t, { accounts: [] });
  f.members.set(BOT, { id: BOT, user: { id: BOT, bot: true } });
  await f.feature.onStartup(f.client); await flush(); assert.equal(f.handles.length, 0); assert.equal(f.core.current, null);
});
test('manual policy still never opens audio without a current participant click', async t => {
  const f = fixture(t, { mode: 'manual' }); await f.feature.onStartup(f.client); await flush();
  assert.equal(f.handles.length, 0); assert.equal(f.core.status().consentMode, 'manual');
  await f.feature.buttonHandlers.local_transcription_consent(f.interaction(A)); await flush();
  assert.equal(f.handles[0].allowed.has(A), true);
});
test('trusted gateway recovery automatically opens a new channel-policy session without a click', async t => {
  const f = fixture(t); await f.feature.onStartup(f.client); await flush();
  const old = f.core.current.id;
  await f.feature.events.find(event => event.name === Events.ShardDisconnect).execute(); await flush();
  assert.equal(f.core.status().recording, false);
  await f.feature.events.find(event => event.name === Events.ShardResume).execute(); await flush();
  assert.notEqual(f.core.current.id, old); assert.equal(f.handles.at(-1).allowed.has(A), true);
});
test('deliberate End survives occupied restart; known empty resets it and next lone join starts automatically', async t => {
  const f = fixture(t); await f.feature.onStartup(f.client); await flush();
  await f.feature.buttonHandlers.local_transcription_end(f.interaction(A)); await flush();
  assert.equal(f.core.status().holdUntilEmpty, true);
  await f.feature.cleanup(); f.create(); await f.feature.onStartup(f.client); await flush();
  assert.equal(f.handles.length, 1); assert.equal(f.core.current, null);
  await f.change(A, false); await f.change(A, true);
  assert.equal(f.handles.length, 2); assert.equal(f.handles.at(-1).allowed.has(A), true);
});
test('personal Stop beats stalled acknowledgement and survives polling, nonempty rejoin and restart; Resume is deliberate', async t => {
  const f = fixture(t, { accounts: [A, B] }); await f.feature.onStartup(f.client); await flush();
  assert.deepEqual([...f.handles[0].allowed].sort(), [A, B]);
  let acknowledge;
  const stopping = f.feature.buttonHandlers.local_transcription_revoke(f.interaction(A, { async deferReply() { this.deferred = true; await new Promise(resolve => { acknowledge = resolve; }); } }));
  await flush(); assert.equal(f.handles[0].emit(A), false);
  assert.deepEqual(f.core.store.getAutomaticOptOuts(), [A]);
  await f.core.membership([A, B].map(id => ({ id, name: 'Synthetic' }))); await flush(); assert.equal(f.handles[0].emit(A), false);
  await f.change(A, false); await f.change(A, true); assert.equal(f.handles[0].emit(A), false); assert.equal(f.handles[0].emit(B), true);
  acknowledge(); await stopping;
  await f.feature.cleanup(); f.create(); await f.feature.onStartup(f.client); await flush();
  const fresh = f.handles.at(-1); assert.equal(fresh.allowed.has(A), false); assert.equal(fresh.allowed.has(B), true);
  assert.deepEqual(f.core.store.getAutomaticOptOuts(), [A]);
  await f.feature.buttonHandlers.local_transcription_consent(f.interaction(A)); await flush();
  assert.equal(fresh.allowed.has(A), true); assert.deepEqual(f.core.store.getAutomaticOptOuts(), []);
});

async function idleNotice(f) {
  const id = f.core.current.id;
  f.time(301000); await f.core.tick(); await flush();
  assert.equal(f.core.current, null); assert.equal(f.core.status().idleWait, true);
  const s = f.core.store.getSession(id);
  return { id: s.notice.id, author: { id: BOT } };
}
// interaction() normally selects the current notice; closed controls have no
// current runtime. Use a minimal real Discord-shaped interaction instead.
function closedAction(message, id = A, extra = {}) {
  return { guildId: GUILD, channelId: ALERTS, user: { id, bot: false }, message,
    async reply(payload) { this.replyPayload = payload; },
    async deferReply() { this.deferred = true; }, async editReply(payload) { this.editPayload = payload; }, ...extra };
}
for (const mode of ['manual', 'channel']) test(`${mode} real feature: idle closed notice Start wakes only session control, preserving pauses`, async t => {
  const f = fixture(t, { mode, accounts: [A, B] }); await f.feature.onStartup(f.client); await flush();
  if (mode === 'manual') await f.feature.buttonHandlers.local_transcription_consent(f.interaction(A));
  await f.feature.buttonHandlers.local_transcription_revoke(f.interaction(A));
  const message = await idleNotice(f), row = f.messages.find(row => row.id === message.id);
  assert.match(row.content, /Not recording|recording for this session has stopped/);
  assert.match(row.content, /fresh member arrival/); assert.match(row.content, /Start does not resume paused microphones/);
  const controls = row.components[0].components;
  assert.equal(controls.find(b => b.custom_id === 'local_transcription_start').disabled, false);
  assert.ok(controls.filter(b => b.custom_id !== 'local_transcription_start').every(b => b.disabled));
  const start = closedAction(message);
  await f.feature.buttonHandlers.local_transcription_start(start); await flush();
  assert.ok(f.core.current); assert.match(start.editPayload.content, /new session started/);
  assert.equal(f.core.current.gates.has(A), false);
  if (mode === 'channel') { assert.deepEqual(f.core.store.getAutomaticOptOuts(), [A]); assert.equal(f.core.current.gates.has(B), true); }
  else assert.equal(f.core.current.gates.size, 0);
  assert.ok(row.components[0].components.every(b => b.disabled), 'old Start must be disabled after wake');
  const before = f.core.current.id;
  await f.feature.buttonHandlers.local_transcription_start(closedAction(message)); assert.equal(f.core.current.id, before);
});

test('real feature: idle ignores gateway recovery and restart snapshots; arrival/rejoin while others stay wakes it', async t => {
  const f = fixture(t, { accounts: [A, B] }); await f.feature.onStartup(f.client); await flush();
  await idleNotice(f);
  await f.feature.events.find(event => event.name === Events.ShardDisconnect).execute();
  await f.feature.events.find(event => event.name === Events.ShardResume).execute(); await flush();
  assert.equal(f.core.current, null); assert.equal(f.handles.length, 1);
  await f.feature.cleanup(); f.create(); await f.feature.onStartup(f.client); await flush();
  assert.equal(f.core.current, null); assert.equal(f.handles.length, 1);
  await f.change(A, false); assert.equal(f.core.current, null); await f.change(A, true);
  assert.ok(f.core.current); assert.equal(f.handles.length, 2); assert.equal(f.core.current.gates.has(A), true);
});

test('real feature: unknown to known snapshot alone is not a fresh member arrival', async t => {
  const f = fixture(t); await f.feature.onStartup(f.client); await flush(); await idleNotice(f);
  const guild = await f.client.guilds.fetch(); guild.available = false;
  await f.change(B, true); assert.equal(f.core.status().occupancy, 'unknown');
  guild.available = true;
  // Even a genuine event cannot establish continuity across an unknown snapshot.
  await f.change(B, true); assert.equal(f.core.current, null);
  await f.change(B, false); await f.change(B, true); assert.ok(f.core.current);
});

test('real feature: Start authenticates guild, alerts room, bot author, latest notice and current voice presence', async t => {
  const f = fixture(t); await f.feature.onStartup(f.client); await flush(); const message = await idleNotice(f);
  for (const [id, extra] of [[B, {}], [A, { guildId: VOICE }], [A, { channelId: VOICE }],
    [A, { message: { ...message, author: { id: A } } }], [A, { message: { ...message, id: '999999999999999999' } }],
    [A, { user: { id: A, bot: true } }]]) {
    const action = closedAction(message, id, extra);
    await f.feature.buttonHandlers.local_transcription_start(action);
    assert.equal(f.core.current, null); assert.ok(action.replyPayload);
  }
  const guild = await f.client.guilds.fetch(); guild.available = false;
  await f.feature.buttonHandlers.local_transcription_start(closedAction(message)); assert.equal(f.core.current, null);
  guild.available = true;
  await f.feature.buttonHandlers.local_transcription_start(closedAction(message)); assert.ok(f.core.current);
});
for (const waitAt of ['snapshot', 'acknowledgement']) for (const action of ['stop', 'end', 'unknown'])
  test(`real feature: ${action} fences Start stalled at ${waitAt}`, async t => {
    const f = fixture(t); await f.feature.onStartup(f.client); await flush(); const message = await idleNotice(f);
    let release;
    const fetch = f.client.guilds.fetch;
    const starting = closedAction(message, A, waitAt === 'acknowledgement' ? {
      async deferReply() { this.deferred = true; await new Promise(r => { release = r; }); },
    } : {});
    if (waitAt === 'snapshot') f.client.guilds.fetch = () => new Promise(r => { release = async () => r(await fetch()); });
    const start = f.feature.buttonHandlers.local_transcription_start(starting); await flush(); assert.ok(release);
    if (action === 'unknown') {
      // Gateway fault is synchronous even while the first membership fetch hangs.
      await f.feature.events.find(event => event.name === Events.ShardDisconnect).execute();
    } else await f.feature.buttonHandlers[action === 'stop' ? 'local_transcription_revoke' : 'local_transcription_end'](closedAction(message));
    await release(); await start; f.client.guilds.fetch = fetch; await flush();
    assert.equal(f.core.current, null); assert.equal(f.handles.length, 1);
    if (action === 'stop') assert.deepEqual(f.core.store.getAutomaticOptOuts(), [A]);
    if (action === 'end') assert.equal(f.core.status().holdUntilEmpty, true);
  });

test('real feature: slow Start acknowledgement succeeds when still current; slow new notice POST does not gate channel capture', async t => {
  const f = fixture(t); await f.feature.onStartup(f.client); await flush(); const message = await idleNotice(f);
  let releaseAck, releasePost;
  const post = f.client.rest.post;
  f.client.rest.post = async (route, options) => {
    const result = await post(route, options);
    if (options.body.content.includes('local-notice:')) await new Promise(r => { releasePost = r; });
    return result;
  };
  const start = f.feature.buttonHandlers.local_transcription_start(closedAction(message, A, {
    async deferReply() { this.deferred = true; await new Promise(r => { releaseAck = r; }); },
  }));
  await flush(); assert.equal(f.core.current, null); releaseAck(); await start; await flush();
  assert.equal(f.handles.length, 2); assert.equal(f.handles[1].emit(A), true);
  const session = f.core.store.getSession(f.core.current.id); assert.equal(session.notice.state, 'sending');
  releasePost(); await flush(); assert.equal(f.core.store.getSession(session.id).notice.state, 'sent');
});

test('real feature: End on closed source notice beats Start during slow new voice ready', async t => {
  let ready;
  const f = fixture(t, { openReady: async (_handle, n) => { if (n === 2) await new Promise(r => { ready = r; }); } });
  await f.feature.onStartup(f.client); await flush(); const message = await idleNotice(f);
  const start = f.feature.buttonHandlers.local_transcription_start(closedAction(message)); await flush(); assert.ok(ready);
  const end = f.feature.buttonHandlers.local_transcription_end(closedAction(message)); await flush();
  assert.equal(f.handles[1].emit(A), false); ready(); await Promise.all([start, end]); await flush();
  assert.equal(f.core.current, null); assert.equal(f.core.status().holdUntilEmpty, true);
  assert.equal(f.handles[1].allowed.size, 0);
});

test('real feature: late notice acknowledgement after idle and subsequent wake never re-enables stale Start', async t => {
  const f = fixture(t, { deferNotice: true }); await f.feature.onStartup(f.client); await flush();
  const old = f.core.current.id; f.time(301000); await f.core.tick(); await flush();
  assert.equal(f.core.current, null); assert.equal(f.core.store.getSession(old).notice.closeRequested, true);
  // A fresh arrival wakes without waiting for the old POST to acknowledge.
  await f.change(B, true); assert.ok(f.core.current);
  f.finishNotice(); await flush();
  const session = f.core.store.getSession(old), row = f.messages.find(row => row.id === session.notice.id);
  assert.equal(session.notice.state, 'closed'); assert.equal(session.notice.startEnabled, false);
  assert.ok(row.components[0].components.every(b => b.disabled));
});

test('real feature: fresh arrival survives a superseding mute snapshot and wakes exactly once', async t => {
  const f = fixture(t); await f.feature.onStartup(f.client); await flush(); await idleNotice(f);
  const fetch = f.client.guilds.fetch; let release;
  f.client.guilds.fetch = () => new Promise(resolve => { release = async () => resolve(await fetch()); });
  const arriving = f.change(B, true); await flush(); assert.ok(release);
  f.client.guilds.fetch = fetch;
  const event = f.feature.events.find(event => event.name === Events.VoiceStateUpdate);
  await event.execute({ id: B, guild: { id: GUILD }, channelId: VOICE }, { id: B, guild: { id: GUILD }, channelId: VOICE, selfMute: true });
  await flush(); assert.ok(f.core.current); assert.equal(f.handles.length, 2);
  assert.equal(f.core.current.gates.has(B), true);
  await release(); await arriving; assert.equal(f.handles.length, 2);
});

for (const action of ['stop', 'end', 'safety', 'unknown', 'disconnect']) test(`real feature: retained arrival evidence is fenced by later ${action}`, async t => {
  const f = fixture(t); await f.feature.onStartup(f.client); await flush(); const message = await idleNotice(f);
  const fetch = f.client.guilds.fetch; let release;
  f.client.guilds.fetch = () => new Promise(resolve => { release = async () => resolve(await fetch()); });
  const arriving = f.change(B, true); await flush(); assert.ok(release); f.client.guilds.fetch = fetch;
  if (action === 'stop' || action === 'end') await f.feature.buttonHandlers[action === 'stop' ? 'local_transcription_revoke' : 'local_transcription_end'](closedAction(message));
  else if (action === 'safety') await f.core.fault('VOICE_ERROR');
  else if (action === 'unknown') await f.core.membership(null);
  else {
    await f.feature.events.find(event => event.name === Events.ShardDisconnect).execute();
    await f.feature.events.find(event => event.name === Events.ShardResume).execute();
  }
  const event = f.feature.events.find(event => event.name === Events.VoiceStateUpdate);
  await event.execute({ id: B, guild: { id: GUILD }, channelId: VOICE }, { id: B, guild: { id: GUILD }, channelId: VOICE, selfMute: true });
  await release(); await arriving; await flush();
  assert.equal(f.core.current, null); assert.equal(f.handles.length, 1);
  assert.equal(f.handles[0].allowed.size, 0);
});

test('real feature: retained arrival absent from the final snapshot cannot wake', async t => {
  const f = fixture(t); await f.feature.onStartup(f.client); await flush(); await idleNotice(f);
  const fetch = f.client.guilds.fetch; let release;
  f.client.guilds.fetch = () => new Promise(resolve => { release = async () => resolve(await fetch()); });
  const arriving = f.change(B, true); await flush(); assert.ok(release); f.client.guilds.fetch = fetch;
  await f.change(B, false); await release(); await arriving;
  assert.equal(f.core.current, null); assert.equal(f.handles.length, 1);
});

test('real feature: arrival observed before inactivity cannot replay after its delayed snapshot', async t => {
  const f = fixture(t); await f.feature.onStartup(f.client); await flush();
  const fetch = f.client.guilds.fetch; let release;
  f.client.guilds.fetch = () => new Promise(resolve => { release = async () => resolve(await fetch()); });
  const arriving = f.change(B, true); await flush(); assert.ok(release);
  await idleNotice(f); await release(); await arriving; f.client.guilds.fetch = fetch;
  assert.equal(f.core.current, null); assert.equal(f.handles.length, 1);
  await f.change(B, false); await f.change(B, true); assert.equal(f.handles.length, 2);
});

test('real feature: a fast leave/rejoin wakes idle even when the older leave snapshot is still blocked', async t => {
  const f = fixture(t, { accounts: [A, B] }); await f.feature.onStartup(f.client); await flush();
  await f.feature.buttonHandlers.local_transcription_revoke(f.interaction(A));
  await idleNotice(f); const fetch = f.client.guilds.fetch; let release;
  f.client.guilds.fetch = () => new Promise(resolve => { release = async () => resolve(await fetch()); });
  const leaving = f.change(A, false); await flush(); assert.ok(release); assert.equal(f.core.current, null);
  f.client.guilds.fetch = fetch;
  await f.change(A, true); assert.ok(f.core.current); assert.equal(f.handles.length, 2);
  assert.equal(f.core.current.gates.has(A), false); assert.equal(f.core.current.gates.has(B), true);
  assert.deepEqual(f.core.store.getAutomaticOptOuts(), [A]);
  await release(); await leaving; assert.equal(f.handles.length, 2);
});
