'use strict';
// Actual Store/Coordinator/Publisher and OS lock; only Discord/audio/native STT
// are faked. No bot client, network, or private speech is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Events } = require('discord.js');
const { createFeature } = require('../../src/features/local-transcription');
const { Store } = require('../../src/features/local-transcription/store');
const { loadConfig } = require('../../src/features/local-transcription/config');
const U = '111111111111111111', G = '222222222222222222', V = '333333333333333333', A = '444444444444444444', B = '555555555555555555';
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('SYNTHETIC_INTEGRATION_DEADLINE');
}
test('real port wiring: lone human notice, authenticated consent/revoke/leave, restart never opens audio automatically', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-feature-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({ GUILD_ID: G, VOICE_CHANNEL_ID: V, ALERTS_CHANNEL_ID: A, LOCAL_TRANSCRIPTION_DATA_DIR: root });
  let store, audioOpens = 0, capture, nextId = 666666666666666660n;
  const sends = [], subscriptions = [];
  class ObservedStore extends Store { constructor(options) { super(options); store = this; } }
  class FakeAudio {
    async open(options) { audioOpens++; capture = options;
      return { async setConsented(id, value) { subscriptions.push([id, value]); }, async close() {} };
    }
  }
  const members = new Map([[U, { id: U, displayName: 'Synthetic participant', user: { bot: false } }]]);
  const client = { user: { id: B }, guilds: { async fetch() { return { channels: { async fetch() { return { guild: { id: G }, isVoiceBased: () => true, members }; } } }; } },
    rest: { options: {}, async post(route, options) { sends.push(options.body); return { id: String(nextId++) }; }, async patch() { return {}; }, async get() { return []; } } };
  const deps = { config, Store: ObservedStore, Audio: FakeAudio, recognize: async () => '' };
  const first = createFeature(deps);
  t.after(() => first.cleanup());
  await first.onStartup(client);
  await until(() => store.listSessions().some(session => session.notice.state === 'sent'));
  const active = store.listSessions().find(session => session.phase === 'active');
  assert.ok(active); assert.equal(audioOpens, 0); assert.equal(active.participants[U].consented, false);
  assert.equal(sends[0].components[0].components.length, 4);
  const interaction = () => ({ guildId: G, channelId: A, user: { id: U, bot: false }, message: { id: active.notice.id, author: { id: B } },
    async deferReply() { this.deferred = true; }, async editReply() {}, async reply() {} });
  await first.buttonHandlers.local_transcription_consent(interaction());
  assert.equal(audioOpens, 1); assert.equal(store.getSession(active.id).participants[U].consented, true);
  assert.ok(subscriptions.some(([id, value]) => id === U && value === true));
  const revoked = first.buttonHandlers.local_transcription_revoke(interaction());
  await revoked;
  assert.equal(store.getSession(active.id).participants[U].consented, false);
  assert.equal(capture.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: Date.now() }), false);
  await first.buttonHandlers.local_transcription_consent(interaction());
  members.clear();
  const leave = first.events.find(event => event.name === Events.VoiceStateUpdate).execute({ guild: { id: G }, id: U, channelId: V }, { guild: { id: G }, id: U, channelId: null });
  assert.equal(capture.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: Date.now() }), false);
  await leave; await first.cleanup();
  members.set(U, { id: U, displayName: 'Synthetic participant', user: { bot: false } });
  const second = createFeature(deps); t.after(() => second.cleanup());
  await second.onStartup(client);
  await until(() => store.listSessions().some(session => session.phase === 'active' && session.notice.state === 'sent'));
  assert.equal(audioOpens, 1); // consent twice reused first handle; restart opens none.
  assert.ok(store.listSessions().filter(session => session.phase === 'active').every(session => session.participants[U].consented === false));
  await second.cleanup();
});

test('normal feature cleanup preserves consented buffered EOF tail and holds the actual writer lock through close', { timeout: 10000 }, async t => {
  const { WriterLock } = require('../../src/features/local-transcription/lock');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-feature-tail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({ GUILD_ID: G, VOICE_CHANNEL_ID: V, ALERTS_CHANNEL_ID: A, LOCAL_TRANSCRIPTION_DATA_DIR: root });
  let store, capture, closeTask, finishClose, tailAccepted, nextId = 666666666666666660n;
  class ObservedStore extends Store { constructor(options) { super(options); store = this; } }
  class FakeAudio {
    async open(options) {
      capture = options;
      return { async setConsented() {}, close() {
        return closeTask ||= (async () => {
          tailAccepted = options.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: Date.now() });
          await new Promise(resolve => { finishClose = resolve; });
        })();
      } };
    }
  }
  const members = new Map([[U, { id: U, displayName: 'Synthetic', user: { bot: false } }]]);
  const client = { user: { id: B }, guilds: { async fetch() { return { channels: { async fetch() { return { guild: { id: G }, isVoiceBased: () => true, members }; } } }; } },
    rest: { options: {}, async post() { return { id: String(nextId++) }; }, async patch() {}, async get() { return []; } } };
  const feature = createFeature({ config, Store: ObservedStore, Audio: FakeAudio, recognize: async () => '' });
  t.after(async () => { finishClose?.(); await feature.cleanup(); });
  await feature.onStartup(client);
  await until(() => store.listSessions().some(session => session.notice.state === 'sent'));
  const session = store.listSessions().find(session => session.phase === 'active');
  const interaction = { guildId: G, channelId: A, user: { id: U, bot: false }, message: { id: session.notice.id, author: { id: B } },
    async deferReply() { this.deferred = true; }, async editReply() {}, async reply() {} };
  await feature.buttonHandlers.local_transcription_consent(interaction);
  assert.equal(capture.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: Date.now() }), true);
  const cleanup = feature.cleanup();
  await until(() => !!finishClose);
  assert.equal(tailAccepted, true);
  assert.equal(store.listJobs(session.id).reduce((n, job) => n + job.bytes, 0), 8);
  await assert.rejects(new WriterLock({ root }).acquire(), { code: 'WRITER_LOCK_BUSY' });
  finishClose(); await cleanup;
  const next = new WriterLock({ root });
  await next.acquire(); await next.release();
  assert.equal(store.getSession(session.id).captureEof, true);
});
