'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/features/local-transcription/store');
const { Scheduler } = require('../../src/features/local-transcription/scheduler');
const U = '111111111111111111', V = '222222222222222222';
const tick = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.fail('condition not reached'); }
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-sched-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store({ root, limits: options.storeLimits });
  const createSession = startedAt => store.createSession({ startedAt, participants: Object.fromEntries([U, V].map(id =>
    [id, { id, name: 'User', joinedAt: startedAt, durationMs: 0, consented: true, everConsented: true }])) });
  const createJob = (s, userId = U, startMs = 0) => {
    const j = store.createJob({ sessionId: s.id, userId, startMs }); store.appendPcm(j.id, Buffer.alloc(8)); return store.queueJob(j.id);
  };
  const faults = []; const scheduler = new Scheduler({ store, recognize: async () => 'speech', onFault: c => faults.push(c), ...options });
  return { store, createSession, createJob, scheduler, faults };
}

test('one global slot across speakers/sessions; session fairness and capture-order stored output', async t => {
  let active = 0, peak = 0; const releases = [], calls = [];
  const f = fixture(t, { recognize: job => { active++; peak = Math.max(peak, active); calls.push(job);
    return new Promise(r => releases.push(text => { active--; r(text); })); } });
  const a = f.createSession(1000), b = f.createSession(2000);
  const a1 = f.createJob(a, U, 0), a2 = f.createJob(a, V, 100), a3 = f.createJob(a, U, 200), b1 = f.createJob(b, U, 0);
  f.scheduler.start(); assert.equal(calls.length, 1); f.scheduler.kick(); assert.equal(calls.length, 1);
  assert.equal(calls[0].id, a1.id); assert.equal(path.isAbsolute(calls[0].path), true);
  releases.shift()('first'); await until(() => calls.length === 2); assert.equal(calls[1].id, b1.id);
  releases.shift()('new session'); await until(() => calls.length === 3); assert.equal(calls[2].id, a2.id);
  releases.shift()('second speaker'); await until(() => calls.length === 4); assert.equal(calls[3].id, a3.id);
  releases.shift()('tail'); await until(() => f.scheduler.sessionTerminal(a.id));
  assert.equal(peak, 1); assert.deepEqual(f.store.listJobs(a.id).map(j => j.text), ['first', 'second speaker', 'tail']);
  await f.scheduler.shutdown(); assert.equal(f.store.status().spoolBytes, 0);
});

test('timeout requests abort but NEVER releases native slot until the recognizer settles', async t => {
  const calls = [], releases = []; let aborts = 0;
  const f = fixture(t, { limits: { jobMs: 10 }, recognize: (j, { signal }) => { calls.push(j.id);
    signal.addEventListener('abort', () => aborts++); return new Promise(r => releases.push(r)); } });
  const s = f.createSession(0), first = f.createJob(s), second = f.createJob(s);
  f.scheduler.start(); await delay(25); assert.equal(aborts, 1); assert.equal(calls.length, 1);
  assert.equal(f.store.getJob(first.id).state, 'running');
  releases.shift()('late'); await until(() => calls.length === 2);
  assert.equal(f.store.getJob(first.id).state, 'failed'); assert.equal(f.store.getJob(first.id).issue, 'RECOGNITION_TIMEOUT');
  assert.equal(f.store.getJob(first.id).text, undefined);
  releases.shift()('next'); await until(() => f.store.getJob(second.id).state === 'recognized'); await f.scheduler.shutdown();
});

test('drain cancellation durably accounts queued and active jobs, ignores late text, and holds global slot', async t => {
  let release; let calls = 0;
  const f = fixture(t, { recognize: () => { calls++; return new Promise(r => { release = r; }); } });
  const a = f.createSession(0), first = f.createJob(a), second = f.createJob(a);
  f.scheduler.start(); f.scheduler.cancelSession(a.id);
  assert.deepEqual(f.store.listJobs(a.id).map(j => j.state), ['cancelled', 'cancelled']);
  assert.equal(f.store.status().spoolBytes, 8); // Running source retained until actual native close.
  const b = f.createSession(1000), third = f.createJob(b); f.scheduler.kick(); assert.equal(calls, 1);
  release('must not be committed'); await until(() => calls === 2);
  assert.equal(f.store.getJob(first.id).text, undefined); assert.equal(fs.existsSync(f.store.file('p', second.id)), false);
  release('new'); await until(() => f.store.getJob(third.id).state === 'recognized'); await f.scheduler.shutdown();
  assert.equal(f.store.status().spoolBytes, 0);
});

test('shutdown awaits abort close, checkpoints running as queued and does not drain backlog', async t => {
  let finishAbort; let aborted = false; let calls = 0;
  const f = fixture(t, { recognize: (_j, { signal }) => { calls++; return new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; finishAbort = () => reject(Error('aborted')); });
  }); } });
  const s = f.createSession(0); f.createJob(s); f.createJob(s); f.scheduler.start();
  let settled = false; const done = f.scheduler.shutdown().then(() => { settled = true; });
  await tick(); assert.equal(aborted, true); assert.equal(settled, false); finishAbort(); await done;
  assert.equal(calls, 1); assert.deepEqual(f.store.listJobs(s.id).map(j => j.state), ['queued', 'queued']);
  assert.equal(f.store.status().spoolBytes, 16);
  const restored = new Store({ root: f.store.root }); restored.recover();
  const recovered = new Scheduler({ store: restored, recognize: async () => 'recovered' }); recovered.start();
  await until(() => recovered.sessionTerminal(s.id)); await recovered.shutdown();
  assert.deepEqual(restored.listJobs(s.id).map(j => j.text), ['recovered', 'recovered']);
});

test('recognizer failure, no-speech, invalid/oversized output and total text cap are terminal and sanitized', async t => {
  const results = [() => { throw Error('private transcript error'); }, () => ({ text: '', noSpeech: true }), () => Buffer.alloc(1), () => 'x'.repeat(65537), () => '12345', () => '67890'];
  const f = fixture(t, { storeLimits: { maxTranscriptBytes: 8 }, recognize: async () => results.shift()() });
  const s = f.createSession(0); for (let i = 0; i < 6; i++) f.createJob(s);
  f.scheduler.start(); await until(() => f.scheduler.sessionTerminal(s.id)); await f.scheduler.shutdown();
  assert.deepEqual(f.store.listJobs(s.id).map(j => j.state), ['failed', 'no_speech', 'failed', 'failed', 'recognized', 'failed']);
  assert.equal(f.store.status().spoolBytes, 0); assert.ok(!JSON.stringify(f.store.listJobs(s.id)).includes('private transcript'));
});

test('empty model output on nonzero or quiet PCM is incomplete, never mislabeled exact-zero no-speech', async t => {
  const f = fixture(t, { recognize: async () => '' }); const s = f.createSession(0);
  const j = f.store.createJob({ sessionId: s.id, userId: U, startMs: 0 });
  f.store.appendPcm(j.id, Buffer.from([1, 0, 0, 0])); f.store.queueJob(j.id); f.scheduler.start();
  await until(() => f.scheduler.sessionTerminal(s.id)); await f.scheduler.shutdown();
  assert.equal(f.store.getJob(j.id).state, 'failed'); assert.equal(f.store.getJob(j.id).issue, 'EMPTY_RECOGNITION');
  assert.ok(f.store.getSession(s.id).issues.includes('EMPTY_RECOGNITION'));
});

test('failed durable terminal write pauses scheduler without deleting source or launching another recognizer', async t => {
  let calls = 0; const f = fixture(t, { recognize: async () => { calls++; return 'text'; } });
  const s = f.createSession(0), j = f.createJob(s); f.createJob(s);
  const original = f.store.terminal; f.store.terminal = () => { throw Error('disk full'); };
  f.scheduler.start(); await until(() => f.scheduler.paused); await f.scheduler.shutdown(); f.store.terminal = original;
  assert.equal(calls, 1); assert.equal(f.store.getJob(j.id).state, 'running');
  assert.equal(fs.existsSync(f.store.file('p', j.id)), true); assert.ok(f.faults.includes('SCHEDULER_STORE_FAILED'));
});


test('only explicit typed noSpeech backed by exact-zero qualifies; plain/typed empty text stays incomplete', async t => {
  for (const [result, nonzero, expected] of [
    [{ text: '', noSpeech: true }, false, 'no_speech'],
    ['', false, 'failed'], [{ text: '' }, false, 'failed'], [{ text: '', noSpeech: false }, false, 'failed'],
    [{ text: '', noSpeech: true }, true, 'failed'],
  ]) {
    const f = fixture(t, { recognize: async () => result }); const s = f.createSession(0);
    const j = f.store.createJob({ sessionId: s.id, userId: U, startMs: 0 });
    f.store.appendPcm(j.id, Buffer.alloc(4, nonzero ? 1 : 0)); f.store.queueJob(j.id); f.scheduler.start();
    await until(() => f.scheduler.sessionTerminal(s.id)); await f.scheduler.shutdown();
    assert.equal(f.store.getJob(j.id).state, expected);
    if (expected === 'failed') assert.equal(f.store.getJob(j.id).issue, 'EMPTY_RECOGNITION');
  }
});
