'use strict';
// Actual durable store + lifecycle + outbox. Only audio/recognition/Discord are
// fake; no credentials, network, app login or private recordings involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/features/local-transcription/store');
const { Coordinator } = require('../../src/features/local-transcription/coordinator');
const { Publisher } = require('../../src/features/local-transcription/publisher');
const { WriterLock } = require('../../src/features/local-transcription/lock');
const A = '1465125548379607094', B = '1465125550036090883', BOT = '1465236568536252527';
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-integrated-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1000, counter = 0;
  const store = new Store({ root });
  const transport = { botUserId: BOT, messages: [], async send(payload) {
    const id = String(1560398382244036720n + BigInt(++counter)); this.messages.unshift({ id, authorId: BOT, content: payload.content }); return { id };
  }, async edit() {}, async history() { return this.messages; } };
  const publisher = new Publisher({ store, transport, now: () => clock });
  const audio = { handles: [], async open(callbacks) {
    const h = { ...callbacks, allowed: new Set(), closed: false, async setConsented(id, value) { if (value) this.allowed.add(id); else this.allowed.delete(id); },
      emit(id, pcm = Buffer.alloc(1920, 1)) { return this.onPcm({ userId: id, pcm, atMs: clock }); }, async close() { this.closed = true; } };
    this.handles.push(h); return h;
  } };
  const recognize = options.recognize || (async () => 'Synthetic recognized words.');
  const coordinator = new Coordinator({ store, audio, publisher, recognize, now: () => clock,
    limits: { quietMs: 10, emptyGraceMs: 20, maxDrainMs: 10000, ...options.limits } });
  const active = () => store.listSessions().find(s => s.phase === 'active');
  return { root, store, transport, publisher, audio, coordinator, active, time: n => { clock = n; } };
}
test('real OS writer lock and real durable store can share the same private root', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-writer-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = new WriterLock({ root }); await lock.acquire();
  try {
    const store = new Store({ root }); assert.deepEqual(store.listSessions(), []);
    const second = new WriterLock({ root }); await assert.rejects(second.acquire(), /WRITER_LOCK_BUSY/);
  } finally { await lock.release(); }
});
test('shutdown retains the real writer lock through late POST acknowledgement and pending notice edit', { timeout: 3000 }, async t => {
  const f = fixture(t), lock = new WriterLock({ root: f.root }); await lock.acquire();
  let resolveSend, resolveEdit, edited = false, stopped = false;
  f.publisher.requestMs = 5;
  const send = f.transport.send.bind(f.transport);
  f.transport.send = payload => payload.content.includes('local-notice:') ? new Promise(resolve => { resolveSend = resolve; }) : send(payload);
  f.transport.edit = () => { edited = true; return new Promise(resolve => { resolveEdit = resolve; }); };
  const patch = f.store.patchSession.bind(f.store);
  f.store.patchSession = (...args) => { assert.equal(lock.acquired, true, 'old writer patched after releasing flock'); return patch(...args); };
  try {
    await f.coordinator.init(); await f.coordinator.membership([{ id: A, name: 'A' }]);
    const id = f.active().id; await f.publisher.notice(id);
    assert.equal(f.store.getSession(id).notice.state, 'uncertain');
    await f.coordinator.fault('TEST_INTERRUPTION'); await flush();
    assert.equal(f.store.getSession(id).notice.state, 'closed');
    f.publisher.requestMs = 1000; resolveSend({ id: '1560398382244036799' }); await flush(); assert.equal(edited, true);
    const stopping = f.coordinator.shutdown().then(async () => { stopped = true; await lock.release(); });
    await flush(); assert.equal(stopped, false);
    const competitor = new WriterLock({ root: f.root }); await assert.rejects(competitor.acquire(), /WRITER_LOCK_BUSY/);
    resolveEdit(); await stopping; assert.equal(f.store.getSession(id).notice.disabled, true);
    const next = new WriterLock({ root: f.root }); await next.acquire(); await next.release();
  } finally {
    resolveSend?.({ id: '1560398382244036799' }); resolveEdit?.();
    await f.coordinator.shutdown().catch(() => {}); await lock.release();
  }
});

test('durable pipeline recognizes during the call but sends canonical only after EOF/accounting', async t => {
  const f = fixture(t); await f.coordinator.init(); await f.coordinator.membership([{ id: A, name: 'A' }]); await flush();
  const s = f.active(); assert.equal(s.notice.state, 'sent'); assert.equal(f.audio.handles.length, 0);
  await f.coordinator.consent(A, s.notice.id); const handle = f.audio.handles[0]; handle.emit(A);
  f.time(1100); await f.coordinator.tick(); await flush();
  assert.equal(f.store.listJobs(s.id)[0].state, 'recognized');
  assert.equal(f.transport.messages.filter(x => x.content.includes('local-final:')).length, 0);
  assert.equal(f.store.status().spoolBytes, 0);
  f.time(2000); await f.coordinator.membership([]); f.time(2021); await f.coordinator.tick(); await flush();
  const ended = f.store.getSession(s.id); assert.equal(ended.phase, 'published');
  assert.equal(ended.accountedBytes, 1920); assert.equal(ended.acceptedBytes, 1920); assert.equal(ended.participants[A].durationMs, 1000);
  assert.equal(f.transport.messages.filter(x => x.content.includes('local-final:')).length, 1);
  await f.coordinator.shutdown();
});
test('old draining job does not block new capture; one global recognizer and isolated summaries', async t => {
  const waiting = []; let running = 0, maximum = 0;
  const f = fixture(t, { recognize: job => new Promise(resolve => { maximum = Math.max(maximum, ++running); waiting.push({ job, finish: text => { running--; resolve(text); } }); }) });
  await f.coordinator.init(); await f.coordinator.membership([{ id: A, name: 'A' }]); await flush();
  const old = f.active(); await f.coordinator.consent(A, old.notice.id); f.audio.handles.at(-1).emit(A);
  f.time(1100); await f.coordinator.tick(); await flush(); assert.equal(waiting.length, 1);
  f.time(2000); await f.coordinator.membership([]); f.time(2021); await f.coordinator.tick(); await flush();
  assert.equal(f.store.getSession(old.id).phase, 'draining');
  f.time(2100); await f.coordinator.membership([{ id: B, name: 'B' }]); await flush();
  const fresh = f.active(); assert.notEqual(fresh.id, old.id); await f.coordinator.consent(B, fresh.notice.id); f.audio.handles.at(-1).emit(B);
  f.time(2200); await f.coordinator.tick(); await flush(); assert.equal(waiting.length, 1);
  waiting[0].finish('OLD SESSION WORDS'); await flush(); assert.equal(waiting.length, 2); assert.equal(maximum, 1);
  assert.equal(f.store.getSession(old.id).phase, 'published'); assert.equal(f.active().id, fresh.id);
  waiting[1].finish('NEW SESSION WORDS'); await flush();
  f.time(3000); await f.coordinator.membership([]); f.time(3021); await f.coordinator.tick(); await flush();
  const finals = f.transport.messages.filter(x => x.content.includes('local-final:'));
  assert.equal(finals.length, 2); assert.ok(finals.some(x => x.content.includes('OLD SESSION WORDS') && !x.content.includes('NEW SESSION WORDS')));
  assert.ok(finals.some(x => x.content.includes('NEW SESSION WORDS') && !x.content.includes('OLD SESSION WORDS')));
  await f.coordinator.shutdown();
});
test('unknown occupancy revokes capture but is never treated as empty', async t => {
  const f = fixture(t); await f.coordinator.init(); await f.coordinator.membership([{ id: A, name: 'A' }]); await flush();
  const s = f.active(); await f.coordinator.consent(A, s.notice.id); const h = f.audio.handles.at(-1); h.emit(A);
  await f.coordinator.membership(null); f.time(9000); await f.coordinator.tick(); await flush();
  assert.equal(f.active().id, s.id); assert.equal(h.emit(A), false); assert.equal(f.coordinator.status().consenting, 0);
  assert.equal(f.transport.messages.filter(x => x.content.includes('local-final:')).length, 0);
  await f.coordinator.membership([{ id: A, name: 'A' }]); assert.equal(h.emit(A), false);
  await f.coordinator.shutdown();
});
test('long finalized transcript is durably held until explicitly approved, never a partial canonical post', async t => {
  const f = fixture(t, { recognize: async () => 'Synthetic long transcript. '.repeat(200) });
  await f.coordinator.init(); await f.coordinator.membership([{ id: A, name: 'A' }]); await flush();
  const s = f.active(); await f.coordinator.consent(A, s.notice.id); f.audio.handles.at(-1).emit(A);
  f.time(1100); await f.coordinator.tick(); await flush(); f.time(2000); await f.coordinator.membership([]); f.time(2021); await f.coordinator.tick(); await flush();
  assert.equal(f.store.getSession(s.id).publication.state, 'held');
  assert.equal(f.store.getSession(s.id).publication.reason, 'ATTACHMENT_APPROVAL_REQUIRED');
  assert.equal(f.transport.messages.filter(x => x.content.includes('local-final:')).length, 0);
  await new Publisher({ store: f.store, transport: f.transport, allowAttachments: true }).publish(s.id);
  assert.equal(f.store.getSession(s.id).publication.state, 'sent');
  await f.coordinator.shutdown();
});
