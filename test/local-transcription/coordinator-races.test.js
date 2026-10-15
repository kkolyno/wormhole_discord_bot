'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/features/local-transcription/store');
const { Coordinator } = require('../../src/features/local-transcription/coordinator');
const U = '111111111111111111', V = '222222222222222222';
const tick = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } assert.fail('condition not reached'); }
async function setup(t, audio, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-races-')); fs.chmodSync(root, 0o700); const store = new Store({ root });
  const calls = { published: 0 }; const publisher = { notice: async id => store.patchSession(id, { notice: { state: 'sent', id: 'notice' } }),
    closeNotice: async id => store.patchSession(id, { notice: { state: 'closed' } }), publish: async () => { calls.published++; } };
  const c = new Coordinator({ store, audio, publisher, recognize: async () => 'speech', limits: { audioOpenMs: 10, audioCloseMs: 10, ...options.limits }, ...options });
  await c.init(); await c.membership([{ id: U, name: 'User' }]);
  t.after(async () => { await c.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }); return { c, store, calls };
}

test('timed-out late audio handshake closes without any subscription, accepted PCM, or revived session', async t => {
  let ready, callbacks, closed = 0, subscribed = 0;
  const f = await setup(t, { open: opts => { callbacks = opts; return new Promise(r => { ready = () => r({
    setConsented: async () => { subscribed++; }, close: async () => { closed++; } }); }); } });
  const id = f.c.current.id; assert.equal(await f.c.consent(U, 'notice'), false);
  assert.equal(f.c.current, null); assert.equal(callbacks.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: Date.now() }), false);
  let shutdown = false; const done = f.c.shutdown().then(() => { shutdown = true; }); await tick(); assert.equal(shutdown, false);
  ready(); await done; assert.equal(closed, 1); assert.equal(subscribed, 0); assert.equal(f.store.listJobs(id).length, 0);
  assert.ok(f.store.getSession(id).issues.includes('AUDIO_OPEN_OR_SUBSCRIBE_FAILED'));
});

test('real fault during handshake clears acceptance and does not permit a later subscription before queued fault teardown', async t => {
  let ready, callbacks; const subs = [];
  const f = await setup(t, { open: opts => { callbacks = opts; return new Promise(r => { ready = () => r({
    setConsented: async (id, yes) => subs.push([id, yes]), close: async () => {} }); }); } }, { limits: { audioOpenMs: 1000 } });
  const consent = f.c.consent(U, 'notice'); await until(() => ready); callbacks.onFault('VOICE_DISCONNECT'); ready();
  assert.equal(await consent, false); await until(() => f.c.current === null);
  assert.ok(!subs.some(([, yes]) => yes)); assert.equal(f.c.status().holdUntilEmpty, true);
});

test('unconfirmed capture EOF is explicitly incomplete, cannot authorize a second physical capture, and shutdown awaits actual close', async t => {
  let close, opens = 0, callbacks;
  const f = await setup(t, { open: async opts => { opens++; callbacks = opts; return {
    setConsented: async () => {}, close: () => new Promise(r => { close = r; }) }; } });
  const id = f.c.current.id, rt = f.c.current; await f.c.consent(U, 'notice'); await f.c.end('notice'); await delay(25);
  assert.equal(f.c.runtimes.has(rt), true); // Core timeout is not physical close.
  assert.ok(f.store.getSession(id).issues.includes('CAPTURE_EOF_UNCONFIRMED'));
  assert.equal(f.store.getSession(id).captureEof, true); // Sealed core input, not a receiver-close claim.
  assert.equal(f.store.getSession(id).captureCloseAcknowledged, false);
  assert.equal(callbacks.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: Date.now() }), false);
  await f.c.membership([]); await f.c.membership([{ id: V, name: 'New user' }]);
  assert.equal(await f.c.consent(V, 'notice'), false); assert.equal(opens, 1);
  let done = false; const shutdown = f.c.shutdown().then(() => { done = true; }); await tick(); assert.equal(done, false);
  close(); await shutdown; assert.equal(done, true); assert.equal(f.c.runtimes.has(rt), false); assert.equal(rt.epochs.size, 0);
});

test('real close-time drain fault makes the old session incomplete without faulting a new session; intentional late teardown stays ignored', async t => {
  let old, release; let opened = 0;
  const f = await setup(t, { open: async opts => {
    opened++;
    if (opened === 1) { old = opts; return { setConsented: async () => {}, close: () => new Promise(r => { release = r; }) }; }
    return { setConsented: async () => {}, close: async () => {} };
  } }, { limits: { audioCloseMs: 1000 } });
  const oldId = f.c.current.id; await f.c.consent(U, 'notice'); await f.c.end('notice'); await until(() => release);
  await f.c.membership([]); await f.c.membership([{ id: V, name: 'New user' }]); const newId = f.c.current.id;
  old.onFault('DRAIN_INCOMPLETE'); release(); assert.equal(await f.c.consent(V, 'notice'), true);
  await until(() => f.store.getSession(oldId).phase === 'ready');
  assert.ok(f.store.getSession(oldId).issues.includes('DRAIN_INCOMPLETE')); assert.equal(f.c.current.id, newId);
  assert.equal(f.c.status().recording, true); assert.deepEqual(f.store.getSession(newId).issues, []);
  old.onFault('BOT_MOVED_OR_DEAFENED'); await tick(); assert.deepEqual(f.store.getSession(newId).issues, []);
  assert.ok(!f.store.getSession(oldId).issues.includes('BOT_MOVED_OR_DEAFENED'));
});

test('durable metadata failure synchronously closes privacy gate and receiver even when lifecycle checkpoint cannot commit', async t => {
  let callbacks, closed = 0;
  const f = await setup(t, { open: async opts => { callbacks = opts; return { setConsented: async () => {}, close: async () => { closed++; } }; } });
  const id = f.c.current.id; await f.c.consent(U, 'notice'); callbacks.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: Date.now() });
  const atomic = f.store.atomic; f.store.atomic = () => { throw Error('private disk error'); };
  await assert.rejects(f.c.end('notice'), /CORE_STORAGE_OR_LIFECYCLE_FAILED/); f.store.atomic = atomic;
  assert.equal(callbacks.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: Date.now() }), false);
  await until(() => closed === 1); assert.equal(f.c.status().failed, true); assert.equal(f.calls.published, 0);
  await f.c.shutdown(); const recovered = new Store({ root: f.store.root }); recovered.recover();
  assert.equal(recovered.listJobs(id)[0].bytes, 4); assert.equal(recovered.listJobs(id)[0].state, 'queued');
});

test('old job result-storage failure stops a separately capturing new session because the paused writer is global', async t => {
  let release; const callbacks = [];
  const f = await setup(t, { open: async opts => { callbacks.push(opts); return { setConsented: async () => {}, close: async () => {} }; } }, {
    recognize: () => new Promise(r => { release = r; }), limits: { maxUtteranceBytes: 8 },
  });
  // Store's immutable PCM chunk bound is separate from the coordinator timing
  // limits: explicitly flush this short old job by ending its input.
  const oldId = f.c.current.id; await f.c.consent(U, 'notice');
  callbacks[0].onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: Date.now() }); await f.c.end('notice'); await until(() => release);
  await f.c.membership([]); await f.c.membership([{ id: V, name: 'New user' }]);
  const newId = f.c.current.id; await f.c.consent(V, 'notice');
  const terminal = f.store.terminal; f.store.terminal = () => { throw Error('private result fsync failure'); }; release('not committed');
  await until(() => f.c.scheduler.paused && f.c.current === null); f.store.terminal = terminal;
  assert.equal(callbacks[1].onPcm({ userId: V, pcm: Buffer.alloc(4), atMs: Date.now() }), false);
  assert.ok(f.store.getSession(newId).issues.includes('SCHEDULER_STORE_FAILED'));
  assert.equal(f.store.listJobs(oldId)[0].state, 'running'); assert.equal(fs.existsSync(f.store.file('p', f.store.listJobs(oldId)[0].id)), true);
});

test('per-user unsubscribe finishes before fresh resubscribe; invalidation epoch memory is participant-bounded', async t => {
  let releaseFalse, callbacks; const calls = [];
  const f = await setup(t, { open: async opts => { callbacks = opts; return {
    setConsented: async (id, yes) => { calls.push(yes); if (!yes && !releaseFalse) await new Promise(r => { releaseFalse = r; }); }, close: async () => {} }; } }, { limits: { audioOpenMs: 1000 } });
  await f.c.consent(U, 'notice'); await f.c.membership([]); await until(() => releaseFalse);
  assert.equal(callbacks.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: Date.now() }), false);
  await f.c.membership([{ id: U, name: 'User again' }]); const consent = f.c.consent(U, 'notice'); await tick();
  assert.deepEqual(calls, [true, false]); releaseFalse(); assert.equal(await consent, true); assert.deepEqual(calls, [true, false, true]);
  for (let i = 0; i < 100; i++) f.c.invalidate(String(100000000000000000n + BigInt(i)));
  assert.ok(f.c.epochs.size <= 1);
});
