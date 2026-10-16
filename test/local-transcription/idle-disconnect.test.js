'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/features/local-transcription/store');
const { Coordinator, DEFAULTS } = require('../../src/features/local-transcription/coordinator');
const { loadConfig } = require('../../src/features/local-transcription/config');
const { finalPayload } = require('../../src/features/local-transcription/publisher');
const U = '111111111111111111', V = '222222222222222222', W = '333333333333333333';
const member = id => ({ id, name: 'Synthetic' });
const turn = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 500; i++) { if (fn()) return; await turn(); } assert.fail('condition not reached'); }
async function fixture(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'idle-core-')); fs.chmodSync(root, 0o700);
  if (!t.resources) {
    t.resources = { cores: [], roots: new Set() };
    t.after(async () => {
      for (const c of t.resources.cores.toReversed()) await c.shutdown();
      for (const dir of t.resources.roots) fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  t.resources.roots.add(root);
  const store = new Store({ root, limits: options.storeLimits }), handles = [], published = [], grants = [];
  let now = options.now ?? 1000;
  const audio = { open: async callbacks => {
    const handle = { ...callbacks, subscriptions: new Set(), async setConsented(id, yes) {
      if (yes) { grants.push(id); this.subscriptions.add(id); } else this.subscriptions.delete(id);
    }, close: async () => {} };
    handles.push(handle);
    if (options.open) await options.open(handle, handles.length);
    if (options.close) handle.close = () => options.close(handle, handles.length);
    return handle;
  } };
  const publisher = {
    notice: async id => store.patchSession(id, { notice: { state: 'sent', id: `notice-${id}` } }),
    closeNotice: async id => { const s = store.getSession(id); store.patchSession(id, { notice: { ...s.notice, state: 'closed', disabled: true } }); },
    publish: async id => {
      const s = store.getSession(id);
      assert.equal(s.captureEof, true); assert.equal(s.phase, 'ready');
      assert.ok(store.listJobs(id).every(j => ['recognized', 'no_speech', 'failed', 'cancelled'].includes(j.state)));
      published.push(id); store.patchSession(id, { phase: 'published', publication: { state: 'sent' } });
    },
  };
  const c = new Coordinator({ store, audio, publisher, consentMode: options.mode || 'channel', now: () => now, elapsedNow: options.elapsedNow,
    recognize: options.recognize || (async () => 'Synthetic words'), limits: { audioOpenMs: 1000, audioCloseMs: 1000, ...options.limits } });
  t.resources.cores.push(c); await c.init();
  const f = { c, store, root, handles, published, grants, time: n => { now = n; },
    members: (ids = [U], arrivalId) => c.membership(ids === null ? null : ids.map(member), { arrivalId }),
    notice: () => store.getSession(c.current.id).notice.id,
    packet: (userId = U, pcm = Buffer.alloc(4, 1), atMs = now, handle = handles.at(-1)) => handle.onPcm({ userId, pcm, atMs }),
    async start(ids = [U]) { await this.members(ids); await turn(); if (c.consentMode === 'manual') await c.consent(ids[0], this.notice()); },
    async idle(at = 301000) { const id = c.current.id; this.time(at); await c.tick(); await until(() => store.getSession(id).notice.state === 'closed'); return id; },
    async wake(noticeId, userId = U) { return c.startAgain(userId, noticeId, c.prepareStart(userId, noticeId)); },
  };
  return f;
}

test('core/config defaults and strict bounded idle env are 15s and 300s', () => {
  const env = { GUILD_ID: U, VOICE_CHANNEL_ID: V, ALERTS_CHANNEL_ID: W };
  assert.equal(DEFAULTS.emptyGraceMs, 15000); assert.equal(DEFAULTS.idleMs, 300000);
  assert.equal(loadConfig(env).limits.idleMs, 300000);
  for (const value of ['', '0', '-1', '1.5', '300x', ' 300', '300 ', '14401', null, '9007199254740992'])
    assert.throws(() => loadConfig({ ...env, LOCAL_TRANSCRIPTION_IDLE_SECONDS: value }), /CONFIG_INVALID/);
  assert.equal(loadConfig({ ...env, LOCAL_TRANSCRIPTION_IDLE_SECONDS: '1' }).limits.idleMs, 1000);
  assert.equal(loadConfig({ ...env, LOCAL_TRANSCRIPTION_IDLE_SECONDS: '14400' }).limits.idleMs, 14400000);
});
for (const mode of ['manual', 'channel']) {
  test(`${mode}: known empty closes at exactly 15 seconds; unknown restarts grace and cannot complete quiet`, async t => {
    const f = await fixture(t, { mode }); await f.start(); f.time(2000); await f.members([]);
    f.time(16999); await f.c.tick(); assert.ok(f.c.current);
    await f.members(null); f.time(17000); await f.c.tick(); assert.ok(f.c.current);
    f.time(20000); await f.members([]); f.time(34999); await f.c.tick(); assert.ok(f.c.current);
    f.time(35000); const id = f.c.current.id; await f.c.tick(); assert.equal(f.c.current, null);
    await until(() => f.published.includes(id));
    const s = f.store.getSession(id); assert.equal(s.stopReason, 'known_empty'); assert.equal(s.endedAt, 20000);
    assert.ok(s.issues.includes('OCCUPANCY_UNKNOWN')); assert.equal(f.c.status().idleWait, false);
  });
  test(`${mode}: never-spoke session idles at exact 300s and occupied polling never reopens it`, async t => {
    const f = await fixture(t, { mode }); await f.start(); const id = f.c.current.id;
    f.time(300999); await f.c.tick(); assert.ok(f.c.current);
    await f.idle(); assert.equal(f.c.current, null); assert.equal(f.store.getSession(id).stopReason, 'inactivity');
    assert.equal(f.c.status().idleWait, true); assert.equal(f.c.status().holdUntilEmpty, false);
    for (let i = 0; i < 100; i++) await f.members();
    assert.equal(f.c.current, null); assert.equal(f.handles.length, 1);
  });
  test(`${mode}: accepted nonzero PCM resets using trusted coordinator clock; exact zero and excluded users do not`, async t => {
    const f = await fixture(t, { mode }); await f.start();
    f.time(300000); assert.equal(f.packet(U, Buffer.alloc(4, 1), -99999999), true);
    assert.equal(f.c.current.lastActivityAt, 300000);
    f.time(599999); assert.equal(f.packet(U, Buffer.alloc(4), 999999999999), true);
    assert.equal(f.packet(V), false); assert.equal(f.c.current.lastActivityAt, 300000);
    await f.c.tick(); assert.ok(f.c.current); await f.idle(600000); assert.equal(f.c.current, null);
  });
  test(`${mode}: Start preserves personal Stops and never grants manual consent`, async t => {
    const f = await fixture(t, { mode }); await f.start([U, V]); await f.c.revoke(U, f.notice());
    const old = await f.idle(), notice = f.store.getSession(old).notice.id;
    assert.equal(await f.wake(notice), true); assert.notEqual(f.c.current.id, old);
    assert.equal(f.c.current.gates.has(U), false);
    if (mode === 'manual') { assert.equal(f.c.current.gates.size, 0); assert.equal(f.handles.length, 1); }
    else { assert.deepEqual(f.store.getAutomaticOptOuts(), [U]); assert.deepEqual([...f.c.current.gates], [V]); }
    assert.equal(await f.wake(notice), false);
  });
  test(`${mode}: trustworthy new arrival and leave/rejoin wake while others remain, not ordinary changed snapshots`, async t => {
    const f = await fixture(t, { mode }); await f.start([U, V]); const old = await f.idle();
    await f.members([U, V, W]); assert.equal(f.c.current, null); // a poll is not an arrival
    await f.members([U, V]); await f.members([U, V, W], W); assert.notEqual(f.c.current.id, old);
    if (mode === 'manual') assert.equal(f.c.current.gates.size, 0);
    const next = await f.idle(601001);
    await f.members([V, W]); await f.members([U, V, W], U);
    assert.notEqual(f.c.current.id, next); assert.equal(f.c.status().idleWait, false);
  });
  test(`${mode}: unknown recovery/initial snapshot do not count as joins; known empty resets idle`, async t => {
    const f = await fixture(t, { mode }); await f.start(); await f.idle();
    await f.members(null); await f.members([U, V], V); assert.equal(f.c.current, null);
    await f.members([U, V]); assert.equal(f.c.current, null);
    await f.members([]); assert.equal(f.c.status().idleWait, false);
    await f.members([U]); assert.ok(f.c.current);
  });
  test(`${mode}: no manual consent/paused/revoked callbacks cannot keep a session alive`, async t => {
    const f = await fixture(t, { mode });
    if (mode === 'manual') { await f.members(); await turn(); assert.equal(f.handles.length, 0); }
    else { await f.start(); await f.c.revoke(U, f.notice()); f.time(300000); assert.equal(f.packet(), false); }
    await f.idle(); assert.equal(f.c.current, null);
  });
}

test('idle drains accepted EOF and waits for sealed/accounted terminal results; new open waits physical close', async t => {
  let finishClose, finishRecognition;
  const f = await fixture(t, { storeLimits: { maxUtteranceBytes: 4 },
    recognize: () => new Promise(r => { finishRecognition = r; }),
    close: async handle => {
      assert.equal(handle.onPcm({ userId: U, pcm: Buffer.alloc(4, 1), atMs: 301000 }), true);
      await new Promise(r => { finishClose = r; });
    } });
  await f.start(); const oldRuntime = f.c.current, old = await f.idle(); await until(() => finishClose && finishRecognition);
  assert.equal(oldRuntime.lastActivityAt, 1000); assert.equal(f.store.getSession(old).captureEof, false); assert.deepEqual(f.published, []);
  const notice = f.store.getSession(old).notice.id;
  const waking = f.wake(notice); await turn(); assert.equal(f.handles.length, 1);
  finishClose(); assert.equal(await waking, true); assert.equal(f.handles.length, 2);
  const current = f.c.current; assert.equal(current.lastActivityAt, 301000);
  assert.equal(f.packet(U, Buffer.alloc(4, 1), 9999999, f.handles[0]), false);
  assert.equal(current.lastActivityAt, 301000);
  assert.equal(f.store.getSession(old).captureEof, true); assert.deepEqual(f.published, []);
  finishRecognition('Synthetic tail'); await until(() => f.published.includes(old));
  const s = f.store.getSession(old); assert.equal(s.acceptedBytes, 4); assert.equal(s.accountedBytes, 4);
  // Avoid another intentionally blocked synthetic close at cleanup.
  f.handles[1].close = async () => {};
});

test('idle clock starts at actual capture authorization after slow ready', async t => {
  let ready; const f = await fixture(t, { open: async () => new Promise(r => { ready = r; }) });
  const starting = f.members(); await until(() => ready); f.time(500000); ready(); await starting;
  assert.equal(f.c.current.lastActivityAt, 500000); f.time(799999); await f.c.tick(); assert.ok(f.c.current);
  await f.idle(800000); assert.equal(f.c.current, null);
});

test('invalid/rejected packets never reset idle and faults remain explicit incomplete safety stops', async t => {
  for (const pcm of [Buffer.alloc(3, 1), Buffer.alloc(192004, 1)]) {
    const f = await fixture(t); await f.start(); const rt = f.c.current; f.time(300000);
    assert.equal(f.packet(U, pcm), false); assert.equal(rt.lastActivityAt, 1000);
    await until(() => !f.c.current); const s = f.store.getSession(rt.id);
    assert.ok(s.issues.includes('PCM_PACKET_INVALID')); assert.equal(f.c.status().holdUntilEmpty, true);
  }
  const f = await fixture(t, { storeLimits: { maxSpoolBytes: 4 } }); await f.start(); const rt = f.c.current;
  f.time(2000); assert.equal(f.packet(U, Buffer.alloc(8, 1)), false); assert.equal(rt.lastActivityAt, 1000);
  await until(() => !f.c.current); assert.ok(f.store.getSession(rt.id).issues.includes('SPOOL_LIMIT'));
});

test('restart, retention and gateway recovery preserve bounded idle-wait and personal optouts', async t => {
  const f = await fixture(t, { storeLimits: { retentionMs: 100 } }); await f.start([U, V]); await f.c.revoke(U, f.notice());
  const old = await f.idle(); await until(() => f.published.includes(old)); await f.c.shutdown();
  const g = await fixture(t, { root: f.root, now: 400000, storeLimits: { retentionMs: 100 } });
  assert.equal(g.store.getSession(old), null); assert.equal(g.c.status().idleWait, true);
  await g.members([U, V]); assert.equal(g.c.current, null);
  await g.c.fault('GATEWAY_INTERRUPTION'); await g.members(null); await g.members([U, V]); assert.equal(g.c.current, null);
  assert.deepEqual(g.store.getAutomaticOptOuts(), [U]); assert.equal(g.c.prepareStart(U, 'deleted'), null);
  await g.members([V]); await g.members([U, V], U); assert.equal(g.c.current.gates.has(U), false); assert.equal(g.c.current.gates.has(V), true);
  assert.equal(g.store.getControl().idleWait, false);
  assert.ok(!JSON.stringify(g.c.status()).includes(U));
  assert.deepEqual(Object.keys(g.store.getControl()).sort(), ['automaticOptOuts', 'holdUntilEmpty', 'idleWait']);
});

for (const action of ['stop', 'end', 'unknown', 'safety']) test(`pending Start is fenced synchronously by later ${action} behind a queue barrier`, async t => {
  const f = await fixture(t); await f.start(); const old = await f.idle(), notice = f.store.getSession(old).notice.id;
  const token = f.c.prepareStart(U, notice); assert.ok(token);
  let release; const barrier = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const start = f.c.startAgain(U, notice, token);
  const cutoff = action === 'stop' ? f.c.revoke(U, notice) : action === 'end' ? f.c.end(notice)
    : action === 'unknown' ? f.members(null) : f.c.fault('VOICE_ERROR');
  release(); await barrier; assert.equal(await start, false); await cutoff;
  assert.equal(f.c.current, null); assert.equal(f.handles.length, 1);
  if (action === 'stop') assert.deepEqual(f.store.getAutomaticOptOuts(), [U]);
  if (action === 'end' || action === 'safety') {
    assert.equal(f.c.status().holdUntilEmpty, true);
    await f.members([U, V], V); assert.equal(f.c.current, null); assert.equal(await f.wake(notice), false);
  }
});
for (const action of ['stop', 'end', 'unknown', 'safety']) test(`Start slow voice ready cannot subscribe after ${action}`, async t => {
  let ready;
  const f = await fixture(t, { open: async (_handle, n) => { if (n === 2) await new Promise(r => { ready = r; }); } });
  await f.start(); const old = await f.idle(), notice = f.store.getSession(old).notice.id;
  const starting = f.wake(notice); await until(() => ready);
  const cutoff = action === 'stop' ? f.c.revoke(U, notice) : action === 'end' ? f.c.end(notice)
    : action === 'unknown' ? f.members(null) : f.c.fault('VOICE_ERROR');
  ready(); assert.equal(await starting, false); await cutoff;
  assert.equal(f.handles[1].subscriptions.size, 0); assert.equal(f.c.current, null);
  if (action === 'stop') assert.deepEqual(f.store.getAutomaticOptOuts(), [U]);
  if (action === 'end' || action === 'safety') assert.equal(f.c.status().holdUntilEmpty, true);
});

for (const action of ['end', 'safety']) test(`older coalesced empty cannot erase newer idle ${action} hold or capture even briefly`, async t => {
  const f = await fixture(t); await f.start(); const old = await f.idle(), notice = f.store.getSession(old).notice.id;
  let release; const barrier = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const empty = f.members([]), occupied = f.members([U]);
  const cutoff = action === 'end' ? f.c.end(notice) : f.c.fault('VOICE_ERROR');
  assert.equal(f.store.getControl().holdUntilEmpty, true);
  release(); await Promise.all([barrier, empty, occupied, cutoff]);
  assert.equal(f.handles.length, 1, 'no interim receiver open');
  assert.deepEqual(f.grants, [U], 'no subscription after the original session');
  assert.equal(f.store.listSessions().length, 1, 'no interim runtime');
  assert.equal(f.c.current, null);
  assert.equal(new Store({ root: f.root }).getControl().holdUntilEmpty, true);
  await f.members([U, V], V); assert.equal(f.handles.length, 1);
  await f.members([]); assert.equal(f.store.getControl().holdUntilEmpty, false);
  await f.members([U]); assert.equal(f.handles.length, 2, 'newer known empty resets normally');
});

for (const reason of ['inactivity', 'known_empty']) test(`separate monotonic clock enforces ${reason} deadline despite wall rollback and final payload stays publishable`, async t => {
  let elapsed = 1000;
  const f = await fixture(t, { now: 1000000, elapsedNow: () => elapsed }); await f.start(); const id = f.c.current.id;
  if (reason === 'inactivity') {
    f.time(900000); elapsed = 2000; assert.equal(f.packet(), true);
    f.time(800000); elapsed = 301999; await f.c.tick(); assert.ok(f.c.current);
    elapsed = 302000;
  } else {
    f.time(900000); elapsed = 2000; await f.members([]);
    f.time(800000); elapsed = 16999; await f.c.tick(); assert.ok(f.c.current);
    elapsed = 17000;
  }
  await f.c.tick(); assert.equal(f.c.current, null, 'elapsed deadline must not depend on wall time');
  await until(() => f.published.includes(id));
  const s = f.store.getSession(id); assert.equal(s.stopReason, reason); assert.ok(s.endedAt >= s.startedAt);
  assert.doesNotThrow(() => finalPayload(s, f.store.listJobs(id)));
});

test('rollback after accepted PCM cannot seal an inactivity result before its wall start', async t => {
  let elapsed = 1000;
  const f = await fixture(t, { now: 1000000, elapsedNow: () => elapsed }); await f.start(); const id = f.c.current.id;
  f.time(100); elapsed = 2000; assert.equal(f.packet(), true);
  f.time(300100); elapsed = 302000; await f.c.tick(); assert.equal(f.c.current, null);
  await until(() => f.published.includes(id));
  assert.doesNotThrow(() => finalPayload(f.store.getSession(id), f.store.listJobs(id)));
});

test('rollback End timestamp stays frozen and publishable across its queued lifecycle barrier', async t => {
  let elapsed = 1000;
  const f = await fixture(t, { now: 1000000, elapsedNow: () => elapsed }); await f.start(); const id = f.c.current.id;
  let release; const barrier = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  f.time(900000); const ending = f.c.end(f.notice());
  f.time(2000000); elapsed = 2000000; release(); await Promise.all([barrier, ending]);
  await until(() => f.published.includes(id));
  const s = f.store.getSession(id); assert.equal(s.endedAt, s.startedAt);
  assert.doesNotThrow(() => finalPayload(s, f.store.listJobs(id)));
});

test('production elapsed clock is monotonic by default; injected wall clock compatibility is explicit', async t => {
  const f = await fixture(t);
  const real = new Coordinator({ store: f.store, audio: {}, publisher: {}, recognize: async () => '' });
  const before = performance.now(), actual = real.elapsedNow();
  assert.ok(actual >= before && actual <= performance.now());
  assert.ok(actual < Date.now());
  assert.equal(f.c.elapsedNow(), 1000);
});

for (const action of ['end', 'safety']) test(`a newer known-empty observation after queued idle ${action} resets its hold normally`, async t => {
  const f = await fixture(t); await f.start(); const old = await f.idle(), notice = f.store.getSession(old).notice.id;
  let release; const barrier = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const cutoff = action === 'end' ? f.c.end(notice) : f.c.fault('VOICE_ERROR');
  const empty = f.members([]), occupied = f.members([U]);
  release(); await Promise.all([barrier, cutoff, empty, occupied]);
  assert.equal(f.store.getControl().holdUntilEmpty, false); assert.equal(f.handles.length, 2);
});

test('idle control commit failure closes acceptance, persists fallback hold and never auto-retries', async t => {
  const f = await fixture(t); await f.start();
  const set = f.store.setIdleWait.bind(f.store); f.store.setIdleWait = () => { throw Error('private disk error'); };
  f.time(301000); await assert.rejects(f.c.tick(), /CORE_STORAGE_OR_LIFECYCLE_FAILED/);
  assert.equal(f.c.status().failed, true); assert.equal(f.packet(), false);
  assert.equal(new Store({ root: f.root }).getControl().holdUntilEmpty, true);
  f.store.setIdleWait = set;
});

test('crash inside wake control commit restores idle-wait before retention deletes session intent', async t => {
  const f = await fixture(t, { storeLimits: { retentionMs: 100 } });
  const session = f.store.createSession({ startedAt: 1000 });
  f.store.patchSession(session.id, { idleWakePending: true }); f.store.setIdleWait(false); f.store.setAutomaticOptOut(U, true);
  const reloaded = new Store({ root: f.root, limits: { retentionMs: 100 } });
  reloaded.recover({ now: 2000 }); assert.equal(reloaded.getSession(session.id), null);
  assert.equal(reloaded.getControl().idleWait, true); assert.deepEqual(reloaded.getAutomaticOptOuts(), [U]);
});

test('durable idle control rejects malformed booleans and preserves independent hold and optouts', async t => {
  const f = await fixture(t); f.store.setAutomaticOptOut(U, true); f.store.setHoldUntilEmpty(true); f.store.setIdleWait(true);
  assert.deepEqual(new Store({ root: f.root }).getControl(), { holdUntilEmpty: true, automaticOptOuts: [U], idleWait: true });
  assert.throws(() => f.store.setIdleWait(1), /CONTROL_CORRUPT/);
  f.store.setIdleWait(false); assert.equal(f.store.getControl().holdUntilEmpty, true); assert.deepEqual(f.store.getAutomaticOptOuts(), [U]);
  fs.writeFileSync(path.join(f.root, '.control.json'), JSON.stringify({ holdUntilEmpty: false, idleWait: 'true' }), { mode: 0o600 });
  assert.throws(() => new Store({ root: f.root }), /CONTROL_CORRUPT/);
});

test('Start rejects outsider, stale/old notices, current capture, unknown and safety/max-duration holds', async t => {
  const f = await fixture(t); await f.start(); const id = f.c.current.id, active = f.notice();
  assert.equal(f.c.prepareStart(U, active), null); await f.idle(); const closed = f.store.getSession(id).notice.id;
  assert.equal(f.c.prepareStart(V, closed), null); assert.equal(f.c.prepareStart(U, 'wrong'), null);
  await f.members(null); assert.equal(f.c.prepareStart(U, closed), null); await f.members();
  assert.equal(await f.wake(closed), true); assert.equal(f.c.prepareStart(U, closed), null);
  await f.c.end(f.notice()); await turn(); assert.equal(f.c.prepareStart(U, closed), null);
  const g = await fixture(t, { limits: { maxSessionMs: 100 } }); await g.start(); const notice = g.notice();
  g.time(1100); await g.c.tick(); await turn(); assert.equal(g.c.prepareStart(U, notice), null);
  await g.members([U, V], V); assert.equal(g.c.current, null);
});

test('bounded coalescing retains a fresh arrival, but newer unknown cancels it without occupied retry loop', async t => {
  const f = await fixture(t); await f.start(); await f.idle();
  let release; const barrier = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  const tasks = [f.members([U, V], V)];
  for (let i = 0; i < 1000; i++) tasks.push(f.members([U, V]));
  tasks.push(f.members(null), f.members([U, V]));
  release(); await barrier; await Promise.all(tasks); assert.equal(f.c.current, null); assert.equal(f.handles.length, 1);
  await f.members([U]); await f.members([U, V], V); assert.ok(f.c.current);
});

test('closed-notice personal Stop is durable even when current occupancy is unknown', async t => {
  const f = await fixture(t); await f.start(); const id = await f.idle(), notice = f.store.getSession(id).notice.id;
  await f.members(null); assert.equal(await f.c.revoke(U, notice), true);
  assert.deepEqual(new Store({ root: f.root }).getAutomaticOptOuts(), [U]);
  await f.members([U, V]); assert.equal(f.c.current, null);
  await f.members([V]); await f.members([U, V], U); assert.equal(f.c.current.gates.has(U), false);
});

test('a cancelled wake followed by known empty does not leave a permanent interrupted-wake tombstone', async t => {
  let ready; const f = await fixture(t, { open: async (_handle, n) => { if (n === 2) await new Promise(r => { ready = r; }); } });
  await f.start(); const id = await f.idle(), notice = f.store.getSession(id).notice.id;
  const starting = f.wake(notice); await until(() => ready); const stopping = f.c.revoke(U, notice);
  ready(); await starting; await stopping; await f.members([]); await f.c.shutdown();
  const g = await fixture(t, { root: f.root, now: 400000 });
  assert.equal(g.c.status().idleWait, false); await g.members(); assert.ok(g.c.current);
});

test('interrupted idle-stop intent recovers as incomplete inactivity, never an occupied startup wake', async t => {
  const f = await fixture(t); const s = f.store.createSession({ startedAt: 1000 });
  f.store.setIdleWait(true); // crash between durable idle intent and session close
  const g = await fixture(t, { root: f.root, now: 302000 }); await g.members();
  assert.equal(g.c.current, null); assert.equal(g.c.status().idleWait, true);
  const recovered = g.store.getSession(s.id);
  assert.equal(recovered.stopReason, 'inactivity'); assert.ok(recovered.issues.includes('RESTART_INTERRUPTED'));
});

for (const failAt of ['control', 'session']) test(`wake transaction fails closed on interrupted ${failAt} commit`, async t => {
  const f = await fixture(t); await f.start(); const id = await f.idle(), notice = f.store.getSession(id).notice.id;
  const set = f.store.setIdleWait.bind(f.store), patch = f.store.patchSession.bind(f.store);
  if (failAt === 'control') f.store.setIdleWait = value => { if (!value) throw Error('synthetic disk failure'); return set(value); };
  else f.store.patchSession = (id, change) => {
    if (change.idleWakePending === false) throw Error('synthetic disk failure'); return patch(id, change);
  };
  await assert.rejects(f.wake(notice), /CORE_STORAGE_OR_LIFECYCLE_FAILED/);
  assert.equal(f.c.status().failed, true); assert.equal(f.packet(), false);
  f.store.setIdleWait = set; f.store.patchSession = patch;
  await f.c.shutdown();
  const g = await fixture(t, { root: f.root, now: 400000 }); await g.members(); assert.equal(g.c.current, null);
  assert.equal(g.c.status().idleWait, true);
});
