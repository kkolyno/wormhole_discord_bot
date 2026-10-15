'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/features/local-transcription/store');
const { Coordinator } = require('../../src/features/local-transcription/coordinator');
const U = '111111111111111111', V = '222222222222222222', W = '333333333333333333';
const member = id => ({ id, name: `User ${id.slice(0, 1)}` });
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } assert.fail('condition not reached'); }
class FakeAudio {
  constructor() { this.handles = []; this.subscriptions = []; }
  async open(callbacks) {
    const handle = { ...callbacks, closed: false,
      setConsented: async (id, yes) => { this.subscriptions.push([id, yes]); },
      close: async () => { if (handle.closed) return; handle.closed = true; if (this.tail) handle.onPcm(this.tail); } };
    this.handles.push(handle); return handle;
  }
  pcm(id, bytes, atMs, handle = this.handles.at(-1)) { return handle.onPcm({ userId: id, pcm: Buffer.alloc(bytes, 1), atMs }); }
}
function makePublisher(store, calls) {
  return {
    notice: async id => { calls.notices.push(id); store.patchSession(id, { notice: { state: 'sent', id: `notice-${id}` } }); },
    closeNotice: async id => { calls.closes.push(id); const s = store.getSession(id); store.patchSession(id, { notice: { ...s.notice, state: 'closed' } }); },
    publish: async id => {
      const s = store.getSession(id); assert.equal(s.phase, 'ready'); assert.equal(s.captureEof, true);
      assert.ok(store.listJobs(id).every(j => ['recognized', 'no_speech', 'failed', 'cancelled'].includes(j.state)));
      calls.publications.push(id); store.patchSession(id, { phase: 'published', publication: { state: 'sent', id: `post-${id}` } });
    },
  };
}
async function fixture(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'local-coord-')); fs.chmodSync(root, 0o700);
  if (!t.localResources) {
    t.localResources = { coordinators: [], roots: new Set() };
    t.after(async () => {
      for (const c of t.localResources.coordinators.toReversed()) await c.shutdown();
      for (const dir of t.localResources.roots) fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  t.localResources.roots.add(root);
  let time = 1000; const store = new Store({ root, limits: options.storeLimits }); const audio = options.audio || new FakeAudio();
  const calls = { notices: [], closes: [], publications: [] }; const publisher = options.publisher || makePublisher(store, calls);
  const coordinator = new Coordinator({ store, audio, publisher, recognize: options.recognize || (async () => 'recognized words'),
    now: () => time, limits: { emptyGraceMs: 100, maxDrainMs: 300, ...options.limits } });
  await coordinator.init();
  // Each test owns any unresolved fake ports and settles them before cleanup.
  t.localResources.coordinators.push(coordinator);
  const notice = () => `notice-${coordinator.current.id}`;
  return { coordinator, store, audio, calls, root, notice, setTime: n => { time = n; },
    start: async (ids = [U]) => { await coordinator.membership(ids.map(member)); return coordinator.current.id; } };
}

test('first lone human creates a notice, only current member explicit consent opens/subscribes; bounded status is private', async t => {
  const f = await fixture(t); const id = await f.start(); assert.equal(f.calls.notices.length, 1); assert.equal(f.audio.handles.length, 0);
  assert.equal(await f.coordinator.consent(U, 'wrong'), false); assert.equal(await f.coordinator.consent(V, f.notice()), false);
  assert.equal(await f.coordinator.consent(U, f.notice()), true);
  assert.deepEqual(f.audio.subscriptions, [[U, true]]); assert.equal(f.coordinator.status().recording, true);
  assert.equal(f.store.getSession(id).participants[U].everConsented, true);
  assert.equal(f.audio.pcm(U, 8, 1000), true); assert.equal(f.audio.pcm(V, 8, 1000), false);
  assert.ok(!JSON.stringify(f.coordinator.status()).includes('recognized words'));
});

test('revoke invalidates synchronously before queued work, preserves accepted prefix, and rejoin never auto-consents', async t => {
  const f = await fixture(t); const id = await f.start(); await f.coordinator.consent(U, f.notice());
  f.audio.pcm(U, 8, 1000); const revoke = f.coordinator.revoke(U, f.notice());
  assert.equal(f.audio.pcm(U, 8, 1001), false); await revoke;
  f.setTime(1050); await f.coordinator.membership([]); f.setTime(1070); await f.coordinator.membership([member(U)]);
  assert.equal(f.coordinator.current.id, id); assert.equal(f.store.getSession(id).participants[U].consented, false);
  assert.equal(f.audio.pcm(U, 8, 1070), false); assert.equal(await f.coordinator.consent(U, f.notice()), true);
  f.audio.pcm(U, 4, 1070); await f.coordinator.end(f.notice()); await until(() => f.calls.publications.length === 1);
  assert.equal(f.store.getSession(id).accountedBytes, 12); assert.equal(f.store.getSession(id).participants[U].durationMs, 50);
});

test('leave invalidation during pending voice readiness rejects consent and every later callback', async t => {
  const audio = new FakeAudio(); const open = audio.open.bind(audio); let ready;
  audio.open = async opts => { await new Promise(r => { ready = r; }); return open(opts); };
  const f = await fixture(t, { audio }); const id = await f.start();
  const consent = f.coordinator.consent(U, f.notice()); await until(() => ready);
  f.coordinator.invalidate(U); const leave = f.coordinator.membership([]);
  ready(); assert.equal(await consent, false); await leave;
  assert.equal(f.audio.pcm(U, 8, 1000), false); assert.equal(f.store.listJobs(id).length, 0);
  assert.ok(!audio.subscriptions.some(([id, yes]) => id === U && yes));
  await f.coordinator.membership([member(U)]); assert.equal(f.store.getSession(id).participants[U].consented, false);
});

test('unknown occupancy is NOT empty, resets grace, stops gates and does not extend durations across unknown outage', async t => {
  const f = await fixture(t); const id = await f.start(); await f.coordinator.consent(U, f.notice());
  f.setTime(1050); await f.coordinator.tick(); await f.coordinator.membership(null);
  assert.equal(f.audio.pcm(U, 8, 1060), false); assert.equal(f.coordinator.status().occupancy, 'unknown');
  f.setTime(9000); await f.coordinator.tick(); assert.equal(f.coordinator.current.id, id);
  await f.coordinator.membership([]); f.setTime(9050); await f.coordinator.membership(null);
  f.setTime(9200); await f.coordinator.tick(); assert.equal(f.coordinator.current.id, id);
  await f.coordinator.membership([]); f.setTime(9299); await f.coordinator.tick(); assert.equal(f.coordinator.current.id, id);
  f.setTime(9300); await f.coordinator.tick(); await until(() => f.calls.publications.length === 1);
  assert.equal(f.store.getSession(id).participants[U].durationMs, 50);
  assert.ok(f.store.getSession(id).issues.includes('OCCUPANCY_UNKNOWN'));
});

test('known-empty grace only, one remaining person stays active; all participants cumulative durations preserved', async t => {
  const f = await fixture(t); const id = await f.start([U, V]); f.setTime(1040); await f.coordinator.membership([member(U)]);
  f.setTime(1200); await f.coordinator.tick(); assert.equal(f.coordinator.current.id, id);
  await f.coordinator.membership([member(U), member(V)]); f.setTime(1230); await f.coordinator.membership([]);
  f.setTime(1329); await f.coordinator.tick(); assert.equal(f.coordinator.current.id, id);
  f.setTime(1330); await f.coordinator.tick(); await until(() => f.calls.publications.length === 1);
  const s = f.store.getSession(id); assert.equal(s.stopReason, 'known_empty'); assert.equal(s.endedAt, 1230);
  assert.equal(s.participants[U].durationMs, 230); assert.equal(s.participants[V].durationMs, 70);
  assert.equal(s.participants[V].everConsented, false);
});

test('hard segmentation, >850ms gap and EOF preserve final bytes without inventing silence; stale callbacks ignored', async t => {
  const f = await fixture(t, { storeLimits: { maxUtteranceBytes: 8 }, limits: { maxSessionMs: 1000 } }); const id = await f.start(); await f.coordinator.consent(U, f.notice());
  f.audio.pcm(U, 12, 1000); f.setTime(1851); await f.coordinator.tick();
  f.audio.pcm(U, 4, 1900); f.audio.tail = { userId: U, pcm: Buffer.alloc(4, 2), atMs: 1901 };
  const old = f.audio.handles[0]; f.setTime(2000); await f.coordinator.tick(); await until(() => f.calls.publications.length === 1);
  assert.deepEqual(f.store.listJobs(id).map(j => j.bytes), [8, 4, 8]); assert.equal(f.store.getSession(id).accountedBytes, 20);
  const count = f.store.listJobs(id).length;
  assert.equal(f.audio.pcm(U, 8, 2000, old), false); old.onFault('BOT_MOVED_OR_DEAFENED');
  await tick(); assert.equal(f.store.listJobs(id).length, count); assert.deepEqual(f.store.getSession(id).issues, []);
});

test('old session drains in background while new session captures; global recognizer slot stays one', async t => {
  const releases = [], inputs = []; const f = await fixture(t, { storeLimits: { maxUtteranceBytes: 8 },
    recognize: job => { inputs.push(job); return new Promise(r => releases.push(r)); } });
  const oldId = await f.start(); await f.coordinator.consent(U, f.notice()); f.audio.pcm(U, 8, 1000);
  await f.coordinator.membership([]); f.setTime(1100); await f.coordinator.tick();
  await until(() => f.store.getSession(oldId).captureEof);
  assert.equal(f.calls.publications.length, 0); f.setTime(1200); const newId = await f.start([V]); assert.notEqual(newId, oldId);
  await f.coordinator.consent(V, f.notice()); f.audio.pcm(V, 8, 1200); assert.equal(inputs.length, 1);
  releases.shift()('old call'); await until(() => inputs.length === 2 && f.calls.publications.length === 1);
  assert.equal(f.coordinator.current.id, newId); assert.equal(f.coordinator.status().recording, true);
  releases.shift()('new call'); await until(() => f.store.listJobs(newId)[0].state === 'recognized');
});

test('explicit end holds prompts until known empty, persists hold across recovery, and old notice cannot affect next session', async t => {
  const f = await fixture(t); const id = await f.start(), oldNotice = f.notice(); await f.coordinator.end(oldNotice);
  await until(() => f.calls.publications.length === 1); await f.coordinator.membership([member(V)]);
  assert.equal(f.coordinator.current, null); assert.equal(f.store.getSession(id).holdUntilEmpty, true);
  await f.coordinator.shutdown(); const g = await fixture(t, { root: f.root });
  await g.coordinator.membership([member(U)]); assert.equal(g.coordinator.current, null);
  await g.coordinator.membership(null); await g.coordinator.membership([member(U)]); assert.equal(g.coordinator.current, null);
  await g.coordinator.membership([]); await g.start();
  assert.equal(await g.coordinator.consent(U, oldNotice), false); assert.equal(await g.coordinator.end(oldNotice), false);
  assert.equal(g.calls.notices.length, 1); assert.equal(g.store.getSession(id).holdUntilEmpty, false);
});

test('drain deadline cancels accepted jobs explicitly, late recognition cannot rewrite result or overlap next call', async t => {
  let release; let calls = 0;
  const f = await fixture(t, { storeLimits: { maxUtteranceBytes: 8 }, recognize: () => { calls++; return new Promise(r => { release = r; }); } });
  const id = await f.start(); await f.coordinator.consent(U, f.notice()); f.audio.pcm(U, 16, 1000);
  await f.coordinator.end(f.notice()); await until(() => f.store.getSession(id).captureEof);
  f.setTime(1300); await f.coordinator.tick(); await until(() => f.calls.publications.length === 1);
  assert.deepEqual(f.store.listJobs(id).map(j => j.state), ['cancelled', 'cancelled']); assert.equal(f.store.getSession(id).accountedBytes, 16);
  assert.ok(f.store.getSession(id).issues.includes('DRAIN_TIMEOUT')); assert.equal(calls, 1);
  release('late secret'); await until(() => !f.coordinator.scheduler.active);
  assert.equal(f.store.listJobs(id)[0].text, undefined); assert.equal(f.store.status().spoolBytes, 0);
});

test('global pending queue overload accounts partial acceptance and rejection, stops capture immediately, never hides incompleteness', async t => {
  let release; const f = await fixture(t, { storeLimits: { maxUtteranceBytes: 8, maxPendingJobs: 1 },
    recognize: () => new Promise(r => { release = r; }) });
  const id = await f.start(); await f.coordinator.consent(U, f.notice());
  assert.equal(f.audio.pcm(U, 20, 1000), false); assert.equal(f.audio.pcm(U, 4, 1001), false);
  await until(() => f.store.getSession(id).captureEof); release('accepted prefix');
  await until(() => f.calls.publications.length === 1); const s = f.store.getSession(id);
  assert.equal(s.receivedBytes, 20); assert.equal(s.acceptedBytes, 8); assert.equal(s.rejectedBytes, 12); assert.equal(s.accountedBytes, 8);
  assert.ok(s.issues.includes('QUEUE_LIMIT')); assert.equal(f.coordinator.status().holdUntilEmpty, true);
});

test('spool and disk failures stop gating; accepted/rejected accounting and failure reasons remain explicit', async t => {
  for (const disk of [false, true]) {
    const f = await fixture(t, { storeLimits: { maxSpoolBytes: 8 } }); const id = await f.start(); await f.coordinator.consent(U, f.notice());
    assert.equal(f.audio.pcm(U, 8, 1000), true);
    if (disk) f.store.appendPcm = () => { const e = Error('private ENOSPC'); e.safeCode = 'PCM_WRITE_FAILED'; throw e; };
    assert.equal(f.audio.pcm(U, 4, 1001), false); await until(() => f.calls.publications.length === 1);
    const s = f.store.getSession(id); assert.equal(s.acceptedBytes, 8); assert.equal(s.rejectedBytes, 4);
    assert.ok(s.issues.includes(disk ? 'PCM_WRITE_FAILED' : 'SPOOL_LIMIT')); assert.ok(!JSON.stringify(f.coordinator.status()).includes('private'));
  }
});

test('queue metadata commit failure preserves accepted durable PCM, faults explicitly, and accounts the eventual terminal job', async t => {
  const f = await fixture(t, { storeLimits: { maxUtteranceBytes: 8 } }); const id = await f.start(); await f.coordinator.consent(U, f.notice());
  const queue = f.store.queueJob.bind(f.store); let first = true;
  f.store.queueJob = jobId => { if (first) { first = false; throw Error('private queue fsync failure'); } return queue(jobId); };
  assert.equal(f.audio.pcm(U, 8, 1000), false); assert.equal(f.audio.pcm(U, 4, 1001), false);
  await until(() => f.calls.publications.length === 1); const s = f.store.getSession(id);
  assert.equal(s.acceptedBytes, 8); assert.equal(s.rejectedBytes, 0); assert.equal(s.accountedBytes, 8);
  assert.ok(s.issues.includes('PCM_STORAGE_FAILED')); assert.equal(f.store.listJobs(id)[0].state, 'recognized');
});

test('restart recovers open PCM and old active durations only to durable lastSeenAt, no capture or auto-consent even when empty', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-restart-')); fs.chmodSync(root, 0o700);
  const before = new Store({ root }); const s = before.createSession({ startedAt: 100, participants: {
    [U]: { id: U, name: 'User', joinedAt: 100, durationMs: 20, consented: true, everConsented: true } } });
  before.patchSession(s.id, { lastSeenAt: 150 }); const j = before.createJob({ sessionId: s.id, userId: U, startMs: 0 }); before.appendPcm(j.id, Buffer.alloc(12));
  const f = await fixture(t, { root }); await f.coordinator.membership([]); await until(() => f.calls.publications.length === 1);
  const recovered = f.store.getSession(s.id); assert.equal(recovered.endedAt, 150); assert.equal(recovered.participants[U].durationMs, 70);
  assert.equal(recovered.participants[U].consented, false); assert.equal(recovered.stopReason, 'restart'); assert.ok(recovered.issues.includes('RESTART_INTERRUPTED'));
  assert.equal(f.audio.handles.length, 0); assert.equal(f.store.getJob(j.id).bytes, 12);
  await f.start(); assert.equal(f.coordinator.status().consenting, 0); assert.equal(f.audio.handles.length, 0);
});

test('shutdown awaits capture EOF and native abort close, checkpoints accepted tail and queued jobs without publishing', async t => {
  const audio = new FakeAudio(); let closeAudio, closeNative; const open = audio.open.bind(audio);
  audio.open = async opts => { const h = await open(opts); h.close = async () => { await new Promise(r => { closeAudio = r; });
    h.onPcm({ userId: U, pcm: Buffer.alloc(4), atMs: 1010 }); h.closed = true; }; return h; };
  const f = await fixture(t, { audio, storeLimits: { maxUtteranceBytes: 8 }, recognize: (_j, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { closeNative = () => reject(Error('closed')); });
  }) });
  const id = await f.start(); await f.coordinator.consent(U, f.notice()); f.audio.pcm(U, 8, 1000);
  let done = false; const shutdown = f.coordinator.shutdown().then(() => { done = true; });
  await until(() => closeAudio); assert.equal(done, false); closeAudio(); await until(() => closeNative);
  assert.equal(done, false); closeNative(); await shutdown;
  assert.equal(f.calls.publications.length, 0); assert.equal(f.store.getSession(id).captureEof, true);
  assert.deepEqual(f.store.listJobs(id).map(j => [j.state, j.bytes]), [['queued', 8], ['queued', 4]]);
  assert.equal(f.store.getSession(id).acceptedBytes, 12); assert.equal(f.audio.pcm(U, 4, 1020), false);
});

test('consent/participant/session duration caps are protective, and actual audio faults invalidate gates synchronously', async t => {
  const f = await fixture(t, { limits: { maxConsenting: 1, maxParticipants: 2, maxSessionMs: 100 } });
  const id = await f.start([U, V]); await f.coordinator.consent(U, f.notice());
  assert.equal(await f.coordinator.consent(V, f.notice()), false); assert.equal(f.coordinator.status().issue, 'CONSENT_LIMIT');
  f.setTime(1100); await f.coordinator.tick(); await until(() => f.calls.publications.length === 1);
  assert.equal(f.store.getSession(id).stopReason, 'duration_limit');
  await f.coordinator.membership([]); const second = await f.start(); await f.coordinator.consent(U, f.notice());
  f.audio.handles.at(-1).onFault('GATEWAY_DISCONNECT'); assert.equal(f.audio.pcm(U, 8, 1100), false);
  await until(() => f.calls.publications.length === 2); assert.ok(f.store.getSession(second).issues.includes('GATEWAY_DISCONNECT'));
  await f.coordinator.membership([]); const third = await f.start([U, V]); await f.coordinator.membership([member(U), member(V), member(W)]);
  await until(() => f.calls.publications.length === 3); assert.ok(f.store.getSession(third).issues.includes('PARTICIPANT_LIMIT'));
});

test('retained-session cap refuses a new capture explicitly without exceeding metadata bounds or disabling retention tick', async t => {
  const f = await fixture(t, { storeLimits: { maxRetainedSessions: 1, retentionMs: 100 } });
  const first = await f.start(); await f.coordinator.end(f.notice()); await until(() => f.calls.publications.length === 1);
  await f.coordinator.membership([]); assert.equal(await f.coordinator.membership([member(V)]), false);
  assert.equal(f.coordinator.current, null); assert.equal(f.coordinator.status().issue, 'SESSION_LIMIT');
  assert.equal(f.coordinator.status().failed, false); assert.equal(f.store.listSessions().length, 1);
  f.setTime(1100); await f.coordinator.tick(); assert.equal(f.store.getSession(first), null);
  await f.coordinator.membership([]); await f.start([V]); assert.equal(f.store.listSessions().length, 1);
  await assert.rejects(f.coordinator.consent('../not-an-account', f.notice()), /INVALID_ACCOUNT_ID/);
});

test('notice/publication failures remain background-owned, do not block new capture or leak raw exceptions', async t => {
  const f = await fixture(t); f.coordinator.publisher.publish = async () => { throw Error('private transport payload'); };
  const id = await f.start(); await f.coordinator.end(f.notice()); await until(() => f.store.getSession(id).phase === 'ready');
  await f.coordinator.membership([]); await f.start([V]); await f.coordinator.consent(V, f.notice());
  assert.equal(f.coordinator.status().recording, true); assert.ok(!JSON.stringify(f.coordinator.status()).includes('private'));
});
