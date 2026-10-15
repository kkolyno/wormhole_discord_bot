'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, DEFAULT_LIMITS } = require('../../src/features/local-transcription/store');
const U = '111111111111111111';
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-store-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function session(store) { return store.createSession({ startedAt: 1000, participants: {
  [U]: { id: U, name: 'User', joinedAt: 1000, durationMs: 0, consented: true, everConsented: true } } }); }
function job(store, s) { return store.createJob({ sessionId: s.id, userId: U, startMs: 0 }); }

test('private root/file ownership, mode, symlink and filename gates; contract defaults', t => {
  const root = temp(t), bad = path.join(root, 'bad'); fs.mkdirSync(bad, { mode: 0o755 });
  assert.throws(() => new Store({ root: bad }), /PRIVATE_ROOT_REQUIRED/);
  const link = path.join(root, 'link'); fs.symlinkSync(bad, link); assert.throws(() => new Store({ root: link }));
  const good = path.join(root, 'good'); const store = new Store({ root: good }); const s = session(store), j = job(store, s);
  for (const name of fs.readdirSync(good)) assert.equal(fs.statSync(path.join(good, name)).mode & 0o777, 0o600);
  assert.throws(() => store.getSession('../outside')); assert.throws(() => store.createJob({ sessionId: s.id, userId: '../../bad', startMs: 0 }));
  fs.unlinkSync(store.file('p', j.id)); fs.symlinkSync(path.join(root, 'bad'), store.file('p', j.id));
  assert.throws(() => store.appendPcm(j.id, Buffer.alloc(4)));
  assert.equal(DEFAULT_LIMITS.maxSpoolBytes, 256 * 1024 * 1024); assert.equal(DEFAULT_LIMITS.maxPendingJobs, 128);
  assert.equal(DEFAULT_LIMITS.maxUtteranceBytes, 8 * 192000); assert.equal(DEFAULT_LIMITS.maxRetainedSessions, 64);
});

test('job metadata precedes audio creation; accepted append is fsynced without rewriting historical JSON', t => {
  const store = new Store({ root: temp(t) }), s = session(store); const originalOpen = fs.openSync;
  let sawIntent = false;
  fs.openSync = function(file, ...args) {
    if (String(file).endsWith('.pcm')) { const id = path.basename(file).slice(2, -4);
      assert.equal(JSON.parse(fs.readFileSync(store.file('j', id), 'utf8')).state, 'recording'); sawIntent = true; }
    return originalOpen.call(fs, file, ...args);
  };
  let j; try { j = job(store, s); } finally { fs.openSync = originalOpen; }
  assert.equal(sawIntent, true);
  const metadata = fs.readFileSync(store.file('j', j.id), 'utf8');
  const sync = fs.fsyncSync; let synced = 0;
  fs.fsyncSync = function(fd) { if (fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size === 8) synced++; return sync.call(fs, fd); };
  try { assert.equal(store.appendPcm(j.id, Buffer.alloc(8, 1)), 8); } finally { fs.fsyncSync = sync; }
  assert.equal(synced, 1); assert.equal(fs.readFileSync(store.file('j', j.id), 'utf8'), metadata);
  assert.equal(store.getJob(j.id).bytes, 8); assert.equal(store.status().spoolBytes, 8);
});

test('restart recovers open PCM from actual aligned length, requeues queued/running, retains terminal text', t => {
  const root = temp(t); let store = new Store({ root }), s = session(store);
  const open = job(store, s); store.appendPcm(open.id, Buffer.alloc(12));
  const queued = job(store, s); store.appendPcm(queued.id, Buffer.alloc(8)); store.queueJob(queued.id);
  const running = job(store, s); store.appendPcm(running.id, Buffer.alloc(4)); store.queueJob(running.id); store.patchJob(running.id, { state: 'running' });
  const done = job(store, s); store.appendPcm(done.id, Buffer.alloc(4)); store.terminal(done.id, 'recognized', { text: 'last words' });
  store = new Store({ root }); store.recover();
  assert.deepEqual(store.listJobs(s.id).map(j => j.state), ['queued', 'queued', 'queued', 'recognized']);
  assert.deepEqual(store.listJobs(s.id).map(j => j.bytes), [12, 8, 4, 4]);
  assert.equal(store.getJob(done.id).text, 'last words'); assert.equal(store.status().spoolBytes, 24);
  assert.ok(store.getSession(s.id).issues.includes('RESTART_INTERRUPTED'));
});

test('missing, unaligned and changed sealed PCM become explicit durable failures and are removed', t => {
  const root = temp(t); let store = new Store({ root }), s = session(store);
  const missing = job(store, s), corrupt = job(store, s), changed = job(store, s);
  store.appendPcm(changed.id, Buffer.alloc(8)); store.queueJob(changed.id);
  fs.unlinkSync(store.file('p', missing.id)); fs.writeFileSync(store.file('p', corrupt.id), Buffer.alloc(3));
  fs.truncateSync(store.file('p', changed.id), 4);
  store = new Store({ root }); store.recover();
  assert.deepEqual(store.listJobs(s.id).map(j => j.state), ['failed', 'failed', 'failed']);
  assert.deepEqual(store.listJobs(s.id).map(j => j.issue), ['PCM_MISSING', 'PCM_CORRUPT', 'PCM_CORRUPT']);
  assert.equal(store.status().spoolBytes, 0); assert.ok(store.getSession(s.id).issues.includes('PCM_CORRUPT'));
});

test('terminal output commits before PCM unlink; restart idempotently cleans terminal PCM', t => {
  const root = temp(t); let store = new Store({ root }), s = session(store), j = job(store, s);
  store.appendPcm(j.id, Buffer.alloc(8)); const unlink = fs.unlinkSync;
  fs.unlinkSync = function(file) { if (file === store.file('p', j.id)) {
    assert.equal(JSON.parse(fs.readFileSync(store.file('j', j.id), 'utf8')).text, 'committed'); throw Error('simulated power loss');
  } return unlink.call(fs, file); };
  try { assert.throws(() => store.terminal(j.id, 'recognized', { text: 'committed' })); } finally { fs.unlinkSync = unlink; }
  assert.equal(fs.existsSync(store.file('p', j.id)), true);
  store = new Store({ root }); store.recover(); store.recover();
  assert.equal(store.getJob(j.id).text, 'committed'); assert.equal(fs.existsSync(store.file('p', j.id)), false);
});

test('failed result commit never removes PCM; fsync failure is not accepted and rollback preserves old prefix', t => {
  const store = new Store({ root: temp(t) }), s = session(store), j = job(store, s); store.appendPcm(j.id, Buffer.alloc(4, 1));
  const sync = fs.fsyncSync; let failed = false;
  fs.fsyncSync = function(fd) { if (!failed && fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size === 8) { failed = true; throw Error('disk'); } return sync.call(fs, fd); };
  try { assert.throws(() => store.appendPcm(j.id, Buffer.alloc(4, 2)), /PCM_WRITE_FAILED/); } finally { fs.fsyncSync = sync; }
  assert.deepEqual(fs.readFileSync(store.file('p', j.id)), Buffer.alloc(4, 1)); assert.equal(store.getJob(j.id).bytes, 4);
  const atomic = store.atomic; store.atomic = () => { throw Error('disk'); };
  assert.throws(() => store.terminal(j.id, 'recognized', { text: 'not durable' })); store.atomic = atomic;
  assert.equal(store.getJob(j.id).state, 'recording'); assert.equal(fs.existsSync(store.file('p', j.id)), true);
});

test('global spool/queue/utterance/transcript/record caps reject rather than silently exceed', t => {
  const store = new Store({ root: temp(t), limits: { maxSpoolBytes: 12, maxPendingJobs: 2, maxUtteranceBytes: 8, maxTranscriptBytes: 6, maxJobRecords: 3 } });
  const s = session(store), a = job(store, s), b = job(store, s);
  assert.throws(() => job(store, s), /QUEUE_LIMIT/);
  store.appendPcm(a.id, Buffer.alloc(8)); assert.throws(() => store.appendPcm(a.id, Buffer.alloc(4)), /UTTERANCE_LIMIT/);
  store.appendPcm(b.id, Buffer.alloc(4)); assert.throws(() => store.appendPcm(b.id, Buffer.alloc(4)), /SPOOL_LIMIT/);
  store.terminal(a.id, 'recognized', { text: 'four' }); const c = job(store, s);
  assert.throws(() => store.terminal(b.id, 'recognized', { text: 'three' }), /TRANSCRIPT_LIMIT/);
  assert.equal(store.getJob(b.id).state, 'recording'); assert.equal(fs.existsSync(store.file('p', b.id)), true);
  store.terminal(b.id, 'failed', { issue: 'TRANSCRIPT_LIMIT' }); store.terminal(c.id, 'no_speech');
  assert.throws(() => job(store, s), /JOB_RECORD_LIMIT/); assert.equal(store.status().transcriptBytes, 4);
});

test('pending, raw spool and transcript budgets are shared globally by old and new sessions', t => {
  const store = new Store({ root: temp(t), limits: { maxPendingJobs: 2, maxSpoolBytes: 12, maxTranscriptBytes: 6 } });
  const old = session(store), next = session(store), a = job(store, old), b = job(store, next);
  store.appendPcm(a.id, Buffer.alloc(8)); store.queueJob(a.id); store.patchJob(a.id, { state: 'running' });
  store.appendPcm(b.id, Buffer.alloc(4)); assert.throws(() => store.appendPcm(b.id, Buffer.alloc(4)), /SPOOL_LIMIT/);
  assert.throws(() => job(store, next), /QUEUE_LIMIT/); store.terminal(a.id, 'recognized', { text: 'old!' });
  assert.throws(() => store.terminal(b.id, 'recognized', { text: 'new!' }), /TRANSCRIPT_LIMIT/);
  assert.equal(store.status().spoolBytes, 4); assert.equal(store.status().transcriptBytes, 4);
  assert.equal(store.getJob(b.id).state, 'recording');
});

test('publisher shallow patches preserve coordinator fields and transcript sorting is capture-time then allocation', t => {
  const store = new Store({ root: temp(t) }), s = session(store);
  store.patchSession(s.id, { notice: { state: 'sent', id: 'notice' } });
  store.patchSession(s.id, { lastSeenAt: 2000 });
  store.patchSession(s.id, { publication: { state: 'held', reason: 'long' } });
  assert.equal(store.getSession(s.id).lastSeenAt, 2000); assert.equal(store.getSession(s.id).notice.id, 'notice');
  const a = store.createJob({ sessionId: s.id, userId: U, startMs: 20 });
  const b = store.createJob({ sessionId: s.id, userId: U, startMs: 10 });
  const c = store.createJob({ sessionId: s.id, userId: U, startMs: 10 });
  assert.deepEqual(store.listJobs(s.id).map(j => j.id), [b.id, c.id, a.id]);
  const copy = store.getSession(s.id); copy.notice.id = 'mutated'; assert.equal(store.getSession(s.id).notice.id, 'notice');
});

test('retention deletes expired ready/published metadata, never active or pending PCM; session cap is explicit', t => {
  const store = new Store({ root: temp(t), limits: { retentionMs: 100, maxRetainedSessions: 2 } });
  const a = session(store), b = session(store); assert.throws(() => session(store), /SESSION_LIMIT/);
  const j = job(store, a); store.appendPcm(j.id, Buffer.alloc(4)); store.terminal(j.id, 'recognized', { text: 'retained briefly' });
  store.patchSession(a.id, { phase: 'ready', endedAt: 2000 }); store.prune(2099); assert.ok(store.getSession(a.id));
  store.prune(2100); assert.equal(store.getSession(a.id), null); assert.ok(store.getSession(b.id));
  assert.equal(store.status().transcriptBytes, 0); assert.equal(store.listJobs(a.id).length, 0);
  assert.equal(new Store({ root: store.root }).listSessions().length, 1);
});

test('corrupt bounded metadata and orphan files fail startup closed, not silently discarded', t => {
  const root = temp(t); const store = new Store({ root }), s = session(store);
  fs.writeFileSync(store.file('s', s.id), '{bad');
  assert.throws(() => new Store({ root }), /METADATA_CORRUPT/);
});
