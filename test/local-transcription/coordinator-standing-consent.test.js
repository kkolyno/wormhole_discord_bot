'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/features/local-transcription/store');
const { Coordinator } = require('../../src/features/local-transcription/coordinator');
const U = '111111111111111111', V = '222222222222222222', W = '333333333333333333';
const member = id => ({ id, name: 'Participant' });
const turn = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await turn(); } assert.fail('condition not reached'); }
async function fixture(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'standing-core-')); fs.chmodSync(root, 0o700);
  if (!t.resources) {
    t.resources = { cores: [], roots: new Set() };
    t.after(async () => {
      for (const c of t.resources.cores.toReversed()) await c.shutdown();
      for (const root of t.resources.roots) fs.rmSync(root, { recursive: true, force: true });
    });
  }
  t.resources.roots.add(root);
  const store = new Store({ root, limits: options.storeLimits }), handles = [], subscriptions = [], publications = [];
  let now = options.now ?? 1000;
  const audio = options.audio || { open: async callbacks => {
    const handle = { ...callbacks, setConsented: async (id, yes) => subscriptions.push([id, yes]), close: async () => {} };
    handles.push(handle); return handle;
  } };
  const publisher = {
    notice: options.notice || (async id => store.patchSession(id, { notice: { state: 'sent', id: `n-${id}` } })),
    closeNotice: async id => { const s = store.getSession(id); store.patchSession(id, { notice: { ...s.notice, state: 'closed' } }); },
    publish: async id => {
      assert.equal(store.getSession(id).phase, 'ready');
      assert.ok(store.listJobs(id).every(j => ['recognized', 'no_speech', 'failed', 'cancelled'].includes(j.state)));
      publications.push(id); store.patchSession(id, { phase: 'published', publication: { state: 'sent' } });
    },
  };
  const c = new Coordinator({ store, audio, publisher, consentMode: options.consentMode ?? 'channel',
    recognize: options.recognize || (async () => 'synthetic words'), now: () => now,
    limits: { audioOpenMs: 1000, audioCloseMs: 1000, emptyGraceMs: 10, ...options.limits } });
  t.resources.cores.push(c); await c.init();
  return { c, store, handles, subscriptions, publications, root, time: n => { now = n; },
    notice: () => `n-${c.current.id}`, start: (ids = [U]) => c.membership(ids.map(member)),
    pcm: (id = U, bytes = 4) => handles.at(-1).onPcm({ userId: id, pcm: Buffer.alloc(bytes, 1), atMs: now }) };
}

test('constructor defaults manual and strictly validates the fixed policy', async t => {
  const f = await fixture(t, { consentMode: 'manual' });
  const opts = { store: f.store, audio: {}, recognize: async () => '', publisher: {} };
  assert.equal(new Coordinator(opts).consentMode, 'manual');
  for (const consentMode of ['', 'CHANNEL', ' channel', null, false, 1])
    assert.throws(() => new Coordinator({ ...opts, consentMode }), /INVALID_CONSENT_MODE/);
  await f.start(); assert.equal(f.handles.length, 0); assert.equal(f.store.getSession(f.c.current.id).consentMode, 'manual');
  assert.throws(() => { f.c.consentMode = 'channel'; }, TypeError);
});

test('channel lone occupant starts before notice HTTP resolves; failed/uncertain notice cannot gate automatic capture', async t => {
  for (const state of ['pending', 'failed', 'uncertain']) {
    let finish; const f = await fixture(t, { notice: async id => {
      if (state === 'pending') await new Promise(r => { finish = r; });
      if (state === 'failed') throw Error('private notice payload');
      if (state === 'uncertain') f.store.patchSession(id, { notice: { state: 'uncertain' } });
    } });
    await f.start(); const s = f.store.getSession(f.c.current.id);
    assert.equal(s.consentMode, 'channel'); assert.equal(s.participants[U].everConsented, true);
    assert.deepEqual(f.subscriptions, [[U, true]]); assert.equal(f.pcm(), true);
    assert.equal(f.c.status().consentMode, 'channel'); assert.equal(f.c.status().automaticOptOuts, 0);
    assert.ok(!JSON.stringify(f.c.status()).includes(U)); assert.ok(!JSON.stringify(f.c.status()).includes('private'));
    finish?.();
  }
});

test('known humans join/rejoin automatically, bots do not; unknown synchronously cuts off and known occupancy restores grants', async t => {
  const f = await fixture(t); await f.c.membership([{ ...member(W), bot: true }]); assert.equal(f.c.current, null);
  await f.c.membership(null); assert.equal(f.c.current, null);
  await f.start(); await f.start([U, V]); assert.equal(f.c.status().consenting, 2);
  await f.start([V]); assert.equal(f.pcm(U), false); await f.start([U, V]); assert.equal(f.pcm(U), true);
  const unknown = f.c.membership(null); assert.equal(f.pcm(U), false); assert.equal(f.pcm(V), false); await unknown;
  assert.equal(f.c.status().occupancy, 'unknown'); await f.start([U, V]); assert.equal(f.c.status().consenting, 2);
});

test('Stop is synchronous and durable ahead of lifecycle/HTTP; polling, other joins, unknown and rejoin preserve it', async t => {
  const f = await fixture(t); await f.start([U, V]);
  let release; const blocked = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const stop = f.c.revoke(U, f.notice()); assert.equal(f.pcm(U), false); assert.equal(f.pcm(V), true);
  assert.deepEqual(new Store({ root: f.root }).getAutomaticOptOuts(), [U]);
  assert.equal(f.c.status().automaticOptOuts, 1); release(); await blocked; await stop;
  await f.start([U, V, W]); await f.c.membership(null); await f.start([V]); await f.start([U, V]);
  assert.equal(f.pcm(U), false); assert.equal(f.pcm(V), true); assert.deepEqual(f.store.getAutomaticOptOuts(), [U]);
  assert.equal(await f.c.consent(U, 'stale-notice'), false); assert.deepEqual(f.store.getAutomaticOptOuts(), [U]);
  assert.equal(await f.c.consent(U, f.notice()), true); assert.equal(f.pcm(U), true);
  assert.deepEqual(f.store.getAutomaticOptOuts(), []);
  await f.c.revoke(U, f.notice()); await f.c.membership([]); assert.deepEqual(f.store.getAutomaticOptOuts(), []);
  await f.start(); assert.equal(f.pcm(), true);
});

test('older queued empty snapshot cannot erase a newer Stop', async t => {
  const f = await fixture(t); await f.start();
  let release; const blocked = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const empty = f.c.membership([]); const stop = f.c.revoke(U, f.notice()); const rejoin = f.start();
  assert.deepEqual(f.store.getAutomaticOptOuts(), [U]); release(); await Promise.all([blocked, empty, stop, rejoin]);
  assert.deepEqual(f.store.getAutomaticOptOuts(), [U]); assert.equal(f.pcm(), false);
});

test('normal restart creates a new automatic session but optouts and explicit End survive restart and pruning', async t => {
  const f = await fixture(t, { storeLimits: { retentionMs: 100 } }); await f.start([U, V]);
  const old = f.c.current.id; await f.c.revoke(U, f.notice()); await f.c.shutdown();
  const g = await fixture(t, { root: f.root, now: 2000, storeLimits: { retentionMs: 100 } });
  assert.equal(g.store.getSession(old), null); await g.start([U, V]); assert.notEqual(g.c.current.id, old);
  assert.equal(g.pcm(U), false); assert.equal(g.pcm(V), true); assert.deepEqual(g.store.getAutomaticOptOuts(), [U]);
  const ended = g.c.current.id; await g.c.end(g.notice()); await until(() => g.publications.includes(ended)); await g.c.shutdown();
  const h = await fixture(t, { root: f.root, now: 3000, storeLimits: { retentionMs: 100 } });
  await h.start([U, V]); assert.equal(h.c.current, null); await h.c.membership(null); await h.start(); assert.equal(h.c.current, null);
  assert.deepEqual(h.store.getAutomaticOptOuts(), [U]); await h.c.membership([]); await h.start(); assert.equal(h.pcm(), true);
});

for (const action of ['revoke', 'leave', 'end', 'unknown']) test(`automatic readiness rechecks ${action} privacy barrier and does not subscribe late`, async t => {
  let ready, callbacks; const subs = [];
  const f = await fixture(t, { audio: { open: opts => { callbacks = opts; return new Promise(r => { ready = () => r({
    setConsented: async (id, yes) => subs.push([id, yes]), close: async () => {},
  }); }); } } });
  const start = f.start(); await until(() => ready);
  const cutoff = action === 'revoke' ? f.c.revoke(U, f.notice()) : action === 'end' ? f.c.end(f.notice())
    : f.c.membership(action === 'leave' ? [] : null);
  assert.equal(callbacks.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: 1000 }), false);
  ready(); await start; await cutoff;
  assert.ok(!subs.some(([, yes]) => yes));
  if (action === 'revoke') { await f.start(); assert.deepEqual(f.store.getAutomaticOptOuts(), [U]); assert.ok(!subs.some(([, yes]) => yes)); }
});

test('every automatic account epoch is captured before first account readiness await', async t => {
  let ready; const subs = [];
  const f = await fixture(t, { audio: { open: () => new Promise(r => { ready = () => r({
    setConsented: async (id, yes) => subs.push([id, yes]), close: async () => {},
  }); }) } });
  const start = f.start([U, V]); await until(() => ready); const stop = f.c.revoke(V, f.notice());
  ready(); await start; await stop; assert.ok(subs.some(([id, yes]) => id === U && yes));
  assert.ok(!subs.some(([id, yes]) => id === V && yes));
});

test('stale explicit Resume cannot erase later Stop or a leave/rejoin epoch during pending readiness', async t => {
  for (const later of ['stop', 'leave']) {
    let ready; const subs = [];
    const f = await fixture(t, { audio: { open: () => new Promise(r => { ready = () => r({
      setConsented: async (id, yes) => subs.push([id, yes]), close: async () => {},
    }); }) } });
    f.store.setAutomaticOptOut(U, true); await f.start();
    const resume = f.c.consent(U, f.notice()); await until(() => ready);
    const barrier = later === 'stop' ? f.c.revoke(U, f.notice()) : f.start([V]);
    ready(); assert.equal(await resume, false); await barrier;
    assert.deepEqual(f.store.getAutomaticOptOuts(), [U]); assert.ok(!subs.some(([id, yes]) => id === U && yes));
    if (later === 'leave') await f.start([U, V]); assert.ok(!subs.some(([id, yes]) => id === U && yes));
  }
});

test('Stop during asynchronous subscribe defeats Resume after its durable clear', async t => {
  let subscribed; const f = await fixture(t, { audio: { open: async () => ({
    setConsented: async (_id, yes) => { if (yes) await new Promise(r => { subscribed = r; }); }, close: async () => {},
  }) } });
  f.store.setAutomaticOptOut(U, true); await f.start(); const resume = f.c.consent(U, f.notice()); await until(() => subscribed);
  assert.deepEqual(f.store.getAutomaticOptOuts(), []); const stop = f.c.revoke(U, f.notice());
  subscribed(); assert.equal(await resume, false); await stop; assert.deepEqual(f.store.getAutomaticOptOuts(), [U]);
});

test('automatic over-cap snapshot fails visibly closed rather than recording only its first eligible accounts', async t => {
  const f = await fixture(t, { limits: { maxConsenting: 1 } }); assert.equal(await f.start([U, V]), false);
  assert.equal(f.handles.length, 0); assert.equal(f.c.current, null); assert.equal(f.c.status().holdUntilEmpty, true);
  const s = f.store.listSessions()[0]; assert.ok(s.issues.includes('CONSENT_LIMIT'));
  await f.start(); await f.c.membership(null); await f.start(); assert.equal(f.c.current, null);
  await f.c.membership([]); await f.start(); assert.equal(f.pcm(), true);
  await f.start([U, V]); assert.equal(f.c.current, null); assert.equal(f.pcm(), false);
});

test('only allowlisted gateway stops recover under known channel occupancy; all native/safety stops stay held', async t => {
  for (const code of ['GATEWAY_INTERRUPTION', 'GATEWAY_DISCONNECT', 'GATEWAY_RECONNECT', 'VOICE_ERROR',
    'BOT_MOVED_OR_DEAFENED', 'RECOGNITION_FAILED', 'QUEUE_LIMIT', 'PCM_WRITE_FAILED']) {
    const f = await fixture(t); await f.start(); const old = f.c.current.id;
    await f.c.fault(code); await f.c.membership(null); assert.equal(f.c.current, null);
    await f.start(); const gateway = code.startsWith('GATEWAY_');
    assert.equal(!!f.c.current, gateway); assert.equal(f.c.status().holdUntilEmpty, !gateway);
    if (gateway) { assert.notEqual(f.c.current.id, old); assert.equal(f.pcm(), true); }
    else { await f.start(); assert.equal(f.handles.length, 1); }
  }
});

test('configured duration remains a safety hold in channel mode, not an automatic retry', async t => {
  const f = await fixture(t, { limits: { maxSessionMs: 100 } }); await f.start(); f.time(1100); await f.c.tick();
  assert.equal(f.c.current, null); assert.equal(f.c.status().holdUntilEmpty, true); await f.start(); assert.equal(f.handles.length, 1);
});

test('automatic jobs recognize during the call and canonical publication waits for terminal work and capture EOF', async t => {
  let finish; const f = await fixture(t, { storeLimits: { maxUtteranceBytes: 4 }, recognize: () => new Promise(r => { finish = r; }) });
  await f.start(); const id = f.c.current.id; assert.equal(f.pcm(), true); await until(() => finish);
  assert.equal(f.store.listJobs(id)[0].state, 'running'); assert.deepEqual(f.publications, []);
  finish('synthetic words'); await until(() => f.store.listJobs(id)[0].state === 'recognized');
  assert.deepEqual(f.publications, []); assert.equal(f.c.status().recording, true);
  await f.c.end(f.notice()); await until(() => f.publications.length === 1);
  const s = f.store.getSession(id); assert.equal(s.acceptedBytes, 4); assert.equal(s.accountedBytes, 4);
});

test('pending snapshot coalescing is bounded and preserves unknown/known-empty privacy barriers', async t => {
  const f = await fixture(t); await f.start(); await f.c.revoke(U, f.notice());
  let release; const blocked = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const enqueue = f.c.enqueue.bind(f.c); let queued = 0;
  f.c.enqueue = fn => { queued++; return enqueue(fn); };
  const pending = [f.c.membership(null), f.c.membership([])];
  for (let i = 0; i < 1000; i++) pending.push(f.start());
  assert.equal(queued, 1); release(); await blocked; await Promise.all(pending);
  assert.equal(f.pcm(), true); assert.deepEqual(f.store.getAutomaticOptOuts(), []);
  assert.ok(f.store.getSession(f.c.current.id).issues.includes('OCCUPANCY_UNKNOWN'));
});

test('optout persistence failures and full control fail acceptance immediately with sanitized failure and durable fallback hold', async t => {
  for (const full of [false, true]) {
    const f = await fixture(t); await f.start();
    if (full) for (let i = 0; i < 32; i++) f.store.setAutomaticOptOut(String(100000000000000000n + BigInt(i)), true);
    const set = f.store.setAutomaticOptOut.bind(f.store);
    if (!full) f.store.setAutomaticOptOut = () => { throw Error('private disk error with identifiers'); };
    const stop = f.c.revoke(U, f.notice()); assert.equal(f.pcm(), false); assert.equal(f.c.status().failed, true);
    await assert.rejects(stop, /AUTOMATIC_OPTOUT_FAILED/); f.store.setAutomaticOptOut = set;
    assert.equal(new Store({ root: f.root }).getControl().holdUntilEmpty, true);
    assert.equal(f.c.status().issue, 'AUTOMATIC_OPTOUT_FAILED'); assert.ok(!JSON.stringify(f.c.status()).includes('private'));
    await f.start(); assert.equal(f.c.status().recording, false);
    await f.c.shutdown();
    const g = await fixture(t, { root: f.root }); await g.start();
    assert.equal(g.c.current, null); assert.equal(g.c.status().holdUntilEmpty, true);
  }
});


test('concurrent native safety fault wins over earlier queued gateway recovery and remains held', async t => {
  const f = await fixture(t); await f.start();
  let release; const blocked = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const gateway = f.c.fault('GATEWAY_INTERRUPTION'), native = f.c.fault('VOICE_ERROR');
  release(); await Promise.all([blocked, gateway, native]);
  assert.equal(f.c.status().holdUntilEmpty, true); await f.start(); assert.equal(f.c.current, null);
  assert.ok(f.store.listSessions()[0].issues.includes('VOICE_ERROR'));
});

test('gateway interruption during pending readiness is recoverable, not reclassified as a native retry loop', async t => {
  let rejectOpen, opened = 0;
  const f = await fixture(t, { audio: { open: () => {
    if (++opened === 1) return new Promise((_, reject) => { rejectOpen = reject; });
    return Promise.resolve({ setConsented: async () => {}, close: async () => {} });
  } } });
  const start = f.start(); await until(() => rejectOpen); const gateway = f.c.fault('GATEWAY_DISCONNECT');
  rejectOpen(Error('private interrupted handshake')); await start; await gateway;
  assert.equal(f.c.current, null); assert.equal(f.c.status().holdUntilEmpty, false);
  assert.ok(f.store.listSessions()[0].issues.includes('GATEWAY_DISCONNECT'));
  await f.c.membership(null); await f.start(); assert.equal(f.c.status().recording, true); assert.equal(opened, 2);
});


test('explicit End during queued gateway teardown retains its exact cutoff and durable hold', async t => {
  const f = await fixture(t); await f.start(); const id = f.c.current.id;
  let release; const blocked = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const gateway = f.c.fault('GATEWAY_INTERRUPTION'); f.time(1040); const end = f.c.end(f.notice());
  f.time(2000); release(); await blocked; await gateway; assert.equal(await end, true);
  const s = f.store.getSession(id); assert.equal(s.stopReason, 'explicit_end'); assert.equal(s.endedAt, 1040);
  assert.equal(f.c.status().holdUntilEmpty, true); await f.start(); assert.equal(f.c.current, null);
});


test('coalescing cannot hide a brief over-cap eligible snapshot behind a later smaller poll', async t => {
  const f = await fixture(t, { limits: { maxConsenting: 1 } }); await f.start();
  let release; const blocked = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const capped = f.start([U, V]); assert.equal(f.pcm(), false); const smaller = f.start();
  release(); await blocked; assert.equal(await capped, false); await smaller;
  assert.equal(f.c.current, null); assert.equal(f.c.status().holdUntilEmpty, true);
});

test('coalescing respects intervening End queue order so a later known-empty really releases its hold', async t => {
  const f = await fixture(t); await f.start(); const old = f.c.current.id;
  let release; const blocked = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const poll = f.start(); const end = f.c.end(f.notice()); const empty = f.c.membership([]); const join = f.start();
  release(); await Promise.all([blocked, poll, end, empty, join]);
  assert.notEqual(f.c.current.id, old); assert.equal(f.c.status().holdUntilEmpty, false); assert.equal(f.pcm(), true);
});
