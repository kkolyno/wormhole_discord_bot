'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/features/local-transcription/store');
const { Publisher } = require('../../src/features/local-transcription/publisher');
const BOT = '333333333333333333', NOTICE = '444444444444444444';
const turn = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await turn(); } assert.fail('condition not reached'); }
function fixture(t, requestMs = 1000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-publisher-')); fs.chmodSync(root, 0o700);
  const store = new Store({ root });
  const session = store.createSession({ startedAt: 1000, consentMode: 'channel' });
  store.patchSession(session.id, { phase: 'draining', endedAt: 301000, stopReason: 'inactivity', notice: { state: 'sent', id: NOTICE } });
  store.setIdleWait(true);
  const edits = [], transport = { botUserId: BOT, send: async () => ({ id: NOTICE }), history: async () => [],
    edit: async (id, payload) => { edits.push(payload); } };
  const publisher = new Publisher({ store, transport, requestMs });
  t.after(async () => { await publisher.drain(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, session, transport, publisher, edits };
}
const startButton = payload => payload.components[0].components.find(b => b.custom_id === 'local_transcription_start');

test('slow closed PATCH must correct stale Start after a new session is created at the same timestamp', async t => {
  const f = fixture(t); let release;
  f.transport.edit = async (_id, payload) => {
    f.edits.push(payload); if (f.edits.length === 1) await new Promise(r => { release = r; });
  };
  const closing = f.publisher.closeNotice(f.session.id); await until(() => release);
  assert.equal(startButton(f.edits[0]).disabled, false);
  f.store.createSession({ startedAt: 1000, consentMode: 'channel' });
  release(); await closing;
  assert.equal(f.edits.length, 2); assert.equal(startButton(f.edits[1]).disabled, true);
  assert.ok(f.edits.every(p => p.components[0].components.filter(b => b.custom_id !== 'local_transcription_start').every(b => b.disabled)));
  assert.equal(f.store.getSession(f.session.id).notice.startEnabled, false);
});

test('failed corrective PATCH remains retryable, while session authentication already rejects stale Start', async t => {
  const f = fixture(t); let release;
  f.transport.edit = async (_id, payload) => {
    f.edits.push(payload);
    if (f.edits.length === 1) await new Promise(r => { release = r; });
    if (f.edits.length === 2) throw Error('synthetic network failure');
  };
  const closing = f.publisher.closeNotice(f.session.id); await until(() => release);
  f.store.setHoldUntilEmpty(true); release(); await closing;
  assert.equal(f.store.getSession(f.session.id).notice.startEnabled, true);
  await f.publisher.closeNotice(f.session.id);
  assert.equal(startButton(f.edits.at(-1)).disabled, true); assert.equal(f.store.getSession(f.session.id).notice.startEnabled, false);
});

test('late timed-out POST acknowledgement after new capture cannot enable stale Start or active controls', async t => {
  const f = fixture(t, 20); let release;
  f.store.patchSession(f.session.id, { phase: 'active', stopReason: null, notice: { state: 'pending' } });
  f.transport.send = () => new Promise(r => { release = () => r({ id: NOTICE }); });
  await f.publisher.notice(f.session.id); assert.ok(release);
  f.store.patchSession(f.session.id, { phase: 'draining', stopReason: 'inactivity' });
  await f.publisher.closeNotice(f.session.id);
  f.store.createSession({ startedAt: 302000 });
  release(); await f.publisher.drain();
  assert.ok(f.edits.length); assert.ok(f.edits.every(p => p.components[0].components.every(b => b.disabled)));
  assert.equal(f.store.getSession(f.session.id).notice.state, 'closed');
  assert.equal(f.store.getSession(f.session.id).notice.startEnabled, false);
});

test('recovered idle Start is idempotent while eligible, then disabled by a safety hold', async t => {
  const f = fixture(t); await f.publisher.closeNotice(f.session.id);
  assert.equal(startButton(f.edits[0]).disabled, false); assert.equal(f.store.getSession(f.session.id).notice.startEnabled, true);
  await f.publisher.closeNotice(f.session.id); assert.equal(f.edits.length, 1);
  f.store.setHoldUntilEmpty(true); await f.publisher.closeNotice(f.session.id);
  assert.equal(startButton(f.edits.at(-1)).disabled, true); assert.equal(f.edits.length, 2);
});
