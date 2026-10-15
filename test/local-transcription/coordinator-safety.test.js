'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/features/local-transcription/store');
const { Coordinator } = require('../../src/features/local-transcription/coordinator');
const U = '111111111111111111', V = '222222222222222222';
const member = id => ({ id, name: 'User' });
const turn = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await turn(); } assert.fail('condition not reached'); }
async function fixture(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'coord-safety-')); fs.chmodSync(root, 0o700);
  let time = options.time ?? 1000;
  const store = new Store({ root, limits: options.storeLimits });
  const handles = [], publications = [], notices = [], closes = [];
  const audio = options.audio || { open: async callbacks => {
    const handle = { ...callbacks, setConsented: async () => {}, close: async () => {} }; handles.push(handle); return handle;
  } };
  const publisher = {
    notice: async id => { notices.push(id); store.patchSession(id, { notice: { state: 'sent', id: `n-${id}` } }); },
    closeNotice: async id => { closes.push(id); const s = store.getSession(id); store.patchSession(id, { notice: { ...s.notice, state: 'closed' } }); },
    publish: async id => { publications.push(id); store.patchSession(id, { phase: 'published', publication: { state: 'sent' } }); },
  };
  const c = new Coordinator({ store, audio, publisher, now: () => time, recognize: options.recognize || (async () => 'words'),
    limits: { maxSessionMs: 100, emptyGraceMs: 90, audioOpenMs: 1000, audioCloseMs: 1000, ...options.limits } });
  t.after(async () => { await c.shutdown(); if (!options.keepRoot) fs.rmSync(root, { recursive: true, force: true }); });
  await c.init(); const notice = () => `n-${c.current.id}`;
  return { c, root, store, handles, publications, notices, closes, notice, time: n => { time = n; },
    start: async (ids = [U]) => { await c.membership(ids.map(member)); return c.current.id; },
    pcm: (h, bytes = 4) => h.onPcm({ userId: U, pcm: Buffer.alloc(bytes, 1), atMs: time }) };
}

test('EOF spool rejection belongs to old draining runtime even when new current exists; equality is not completeness', async t => {
  let old, release;
  const f = await fixture(t, { storeLimits: { maxSpoolBytes: 8 }, audio: { open: async callbacks => {
    old = callbacks; return { setConsented: async () => {}, close: () => new Promise(r => { release = r; }) };
  } } });
  const id = await f.start(); await f.c.consent(U, f.notice()); assert.equal(f.pcm(old, 8), true);
  f.time(1100); await f.c.tick(); await until(() => release);
  // Direct turnover seam isolates callback ownership from occupancy policy.
  f.c.startSession(1100); const nextId = f.c.current.id;
  assert.equal(f.pcm(old), false); release(); await until(() => f.publications.includes(id));
  const s = f.store.getSession(id);
  assert.equal(s.receivedBytes, 12); assert.equal(s.acceptedBytes, 8); assert.equal(s.accountedBytes, 8); assert.equal(s.rejectedBytes, 4);
  assert.ok(s.issues.includes('SPOOL_LIMIT')); assert.ok(s.issues.includes('PCM_REJECTED'));
  assert.ok(!s.issues.includes('PCM_ACCOUNTING_MISMATCH')); assert.deepEqual(f.store.getSession(nextId).issues, []);
});

test('any rejected bytes mark incomplete even with consistent accounting and no stored reason', async t => {
  const f = await fixture(t); const id = await f.start();
  f.store.patchSession(id, { phase: 'draining', endedAt: 1000, captureEof: true, receivedBytes: 4, acceptedBytes: 0, rejectedBytes: 4 });
  f.c.maybeFinalize(id); assert.ok(f.store.getSession(id).issues.includes('PCM_REJECTED'));
});

test('leave reaches old closing gates with new current; participant-bounded epochs are removed after physical close', async t => {
  let old, release;
  const f = await fixture(t, { audio: { open: async callbacks => {
    old = callbacks; return { setConsented: async () => {}, close: () => new Promise(r => { release = r; }) };
  } } });
  const id = await f.start(); await f.c.consent(U, f.notice()); const rt = f.c.current;
  f.time(1100); await f.c.tick(); await until(() => release); assert.equal(rt.gates.has(U), true);
  f.c.startSession(1100); assert.equal(f.c.runtimes.size, 2);
  f.c.invalidate(U); assert.equal(f.pcm(old), false); assert.equal(rt.epochs.get(U), 1);
  for (let i = 0; i < 100; i++) f.c.invalidate(String(100000000000000000n + BigInt(i)));
  assert.equal(rt.epochs.size, 1); assert.equal(f.c.epochs.size, 0);
  release(); await until(() => !f.c.runtimes.has(rt)); assert.equal(rt.epochs.size, 0);
  assert.equal(f.store.listJobs(id).length, 0); assert.equal(f.c.runtimes.size, 1);
});

test('closed old notice revoke removes only old closing gate, never new runtime epochs', async t => {
  let old, release;
  const f = await fixture(t, { audio: { open: async callbacks => {
    old = callbacks; return { setConsented: async () => {}, close: () => new Promise(r => { release = r; }) };
  } } });
  await f.start(); const oldNotice = f.notice(); await f.c.consent(U, oldNotice); const rt = f.c.current;
  f.time(1100); await f.c.tick(); await until(() => release); f.c.startSession(1100);
  const revoke = f.c.revoke(U, oldNotice); assert.equal(f.pcm(old), false); assert.equal(rt.gates.size, 0);
  assert.equal(f.c.epochs.size, 0); await revoke; release(); await until(() => !f.c.runtimes.has(rt));
});

test('end validates exact notice then seals acceptance synchronously ahead of queue and freezes stop-time accounting', async t => {
  const f = await fixture(t); const id = await f.start(); await f.c.consent(U, f.notice()); const old = f.handles[0];
  assert.equal(f.pcm(old, 8), true);
  let release; const block = f.c.enqueue(() => new Promise(r => { release = r; })); await until(() => release);
  assert.equal(await f.c.end('wrong-notice'), false); assert.equal(f.pcm(old), true);
  const queuedLeave = f.c.membership([]);
  f.time(1040); const end = f.c.end(f.notice()); assert.equal(f.pcm(old), false); assert.equal(f.c.status().recording, false);
  f.time(1090); release(); await block; await queuedLeave; assert.equal(await end, true); await until(() => f.publications.includes(id));
  const s = f.store.getSession(id); assert.equal(s.endedAt, 1040); assert.equal(s.participants[U].durationMs, 40);
  assert.equal(s.acceptedBytes, 12); assert.equal(s.accountedBytes, 12); assert.equal(s.rejectedBytes, 0);
});

test('end while voice readiness is pending invalidates consent and never subscribes or revives late handle', async t => {
  let ready, callbacks; const subscriptions = [];
  const f = await fixture(t, { audio: { open: opts => { callbacks = opts; return new Promise(r => { ready = () => r({
    setConsented: async (id, yes) => subscriptions.push([id, yes]), close: async () => {},
  }); }); } } });
  const id = await f.start(); const notice = f.notice(); const consent = f.c.consent(U, notice); await until(() => ready);
  const end = f.c.end(notice); const queuedConsent = f.c.consent(U, notice);
  assert.equal(f.pcm(callbacks), false); ready(); assert.equal(await consent, false); assert.equal(await end, true);
  assert.equal(await queuedConsent, false); assert.ok(!subscriptions.some(([, yes]) => yes));
  await until(() => f.publications.includes(id)); assert.equal(f.c.current, null); assert.equal(f.store.listJobs(id).length, 0);
});

test('known-empty grace freezes true end/durations while new session begins before old recognition finishes', async t => {
  let release;
  const f = await fixture(t, { limits: { maxSessionMs: 10000 }, recognize: () => new Promise(r => { release = r; }) });
  const id = await f.start(); await f.c.consent(U, f.notice()); f.pcm(f.handles[0]);
  f.time(1040); await f.c.membership([]); f.time(1130); await f.c.tick(); await until(() => release);
  assert.equal(f.store.getSession(id).endedAt, 1040); assert.equal(f.store.getSession(id).participants[U].durationMs, 40);
  f.time(1200); const next = await f.start([V]); release('old speech'); await until(() => f.publications.includes(id));
  assert.notEqual(next, id); assert.equal(f.store.getSession(id).endedAt, 1040);
  assert.equal(f.store.getSession(id).participants[U].durationMs, 40); assert.equal(f.store.getSession(next).startedAt, 1200);
});

test('safety hold survives session pruning/restart; unknown/nonempty cannot clear it but known-empty can', async t => {
  const f = await fixture(t, { storeLimits: { retentionMs: 100 }, keepRoot: true });
  const id = await f.start(); await f.c.end(f.notice()); await until(() => f.publications.includes(id));
  f.time(1100); await f.c.tick(); assert.equal(f.store.getSession(id), null); await f.c.shutdown();
  const g = await fixture(t, { root: f.root, time: 1200, storeLimits: { retentionMs: 100 } });
  await g.c.membership([member(U)]); assert.equal(g.c.current, null); assert.equal(g.c.status().holdUntilEmpty, true);
  await g.c.membership(null); await g.c.membership([member(U)]); assert.equal(g.c.current, null);
  await g.c.membership([]); assert.equal(g.store.getControl().holdUntilEmpty, false);
  await g.start(); assert.equal(g.notices.length, 1);
});

test('startup expires abandoned speech before native work, old notice closure, or publication', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-expiry-')); fs.chmodSync(root, 0o700);
  const before = new Store({ root, limits: { retentionMs: 100 } });
  for (const phase of ['active', 'draining', 'ready', 'published']) {
    const s = before.createSession({ startedAt: 100, participants: { [U]: { id: U, name: 'User', joinedAt: 100,
      durationMs: 0, consented: true, everConsented: true } } });
    const j = before.createJob({ sessionId: s.id, userId: U, startMs: 0 }); before.appendPcm(j.id, Buffer.alloc(4, 1));
    if (phase === 'ready' || phase === 'published') before.terminal(j.id, 'recognized', { text: 'expired synthetic speech' });
    before.patchSession(s.id, { phase, lastSeenAt: 150, endedAt: phase === 'active' ? null : 150, holdUntilEmpty: true });
  }
  let recognized = 0;
  const f = await fixture(t, { root, time: 1000, storeLimits: { retentionMs: 100 }, recognize: async () => { recognized++; return 'not allowed'; } });
  await turn(); assert.equal(recognized, 0); assert.deepEqual(f.publications, []); assert.deepEqual(f.closes, []);
  assert.equal(f.store.listSessions().length, 0); assert.equal(f.store.listJobs().length, 0);
  assert.equal(f.store.status().spoolBytes, 0); assert.equal(f.store.status().transcriptBytes, 0);
  assert.deepEqual(fs.readdirSync(root), ['.control.json']); assert.equal(f.store.getControl().holdUntilEmpty, true);
});
