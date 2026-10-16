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
function fixture(t, { mode = 'channel', accounts = [A], deferNotice = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-integrated-'));
  let clock = 1000, serial = 0, core, feature, finishNotice;
  const handles = [], messages = [], members = new Map();
  const member = id => ({ id, displayName: id === A ? 'Synthetic A' : 'Synthetic B', user: { id, username: 'Synthetic', bot: false } });
  for (const id of accounts) members.set(id, member(id));
  const channel = { guild: { id: GUILD }, isVoiceBased: () => true, members };
  const guild = { available: true, channels: { cache: new Map([[VOICE, channel]]), fetch: async () => channel } };
  const client = { user: { id: BOT }, guilds: { cache: new Map([[GUILD, guild]]), fetch: async () => guild }, rest: { options: {},
    async post(route, options) {
      const row = { id: String(777777777777777770n + BigInt(++serial)), author: { id: BOT }, content: options.body.content, timestamp: new Date(clock).toISOString() };
      assert.ok(row.content.length <= 2000); messages.unshift(row);
      if (deferNotice && row.content.includes('local-notice:')) return new Promise(resolve => { finishNotice = () => resolve({ id: row.id }); });
      return { id: row.id };
    },
    async patch(route, options) { const row = messages.find(row => route.endsWith('/' + row.id)); if (row) row.content = options.body.content; return {}; },
    async get() { return messages; },
  } };
  class Audio {
    async open(callbacks) {
      const handle = { ...callbacks, allowed: new Set(), closed: false,
        async setConsented(id, value) { if (value) this.allowed.add(id); else this.allowed.delete(id); },
        emit(id) { return this.onPcm({ userId: id, pcm: Buffer.alloc(1920, 1), atMs: clock }); },
        async close() { this.closed = true; this.allowed.clear(); },
      }; handles.push(handle); return handle;
    }
  }
  class Core extends Coordinator {
    constructor(options) { super({ ...options, now: () => clock, limits: { ...options.limits, quietMs: 10, emptyGraceMs: 20 } }); core = this; }
  }
  const config = loadConfig({ GUILD_ID: GUILD, VOICE_CHANNEL_ID: VOICE, ALERTS_CHANNEL_ID: ALERTS, LOCAL_TRANSCRIPTION_DATA_DIR: root, LOCAL_TRANSCRIPTION_CONSENT_MODE: mode });
  function create() { feature = createFeature({ config, Audio, Coordinator: Core, recognize: async () => 'Synthetic automatic brain dump.' }); return feature; }
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
