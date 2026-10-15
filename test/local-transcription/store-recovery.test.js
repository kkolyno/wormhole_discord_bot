'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Store } = require('../../src/features/local-transcription/store');
const U = '111111111111111111';
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-store-recovery-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); const store = new Store({ root });
  const s = store.createSession({ startedAt: 1, participants: { [U]: { id: U, name: 'User', joinedAt: 1, durationMs: 0, consented: true, everConsented: true } } });
  const j = store.createJob({ sessionId: s.id, userId: U, startMs: 0 }); return { root, store, s, j }; }

test('separate writer process SIGKILL leaves durable open/queued/running/result records recoverable without its memory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-kill-recovery-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { Store } = require('./src/features/local-transcription/store');
    const store = new Store({ root: process.argv[1] });
    const userId = '${U}';
    const s = store.createSession({ startedAt: 100, participants: { [userId]: {
      id: userId, name: 'User', joinedAt: 100, durationMs: 0, consented: true, everConsented: true } } });
    store.patchSession(s.id, { lastSeenAt: 150 });
    for (const [state, bytes] of [['recording',12], ['queued',4], ['running',8], ['recognized',4]]) {
      const j = store.createJob({ sessionId: s.id, userId, startMs: 0 }); store.appendPcm(j.id, Buffer.alloc(bytes));
      if (state === 'recognized') store.terminal(j.id, state, { text: 'durable output' });
      else if (state !== 'recording') store.patchJob(j.id, { state });
    }
    fs.writeSync(1, s.id); process.kill(process.pid, 'SIGKILL');
  `, root], { cwd: process.cwd(), encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000 });
  assert.equal(child.signal, 'SIGKILL'); const store = new Store({ root }); store.recover();
  assert.deepEqual(store.listJobs(child.stdout).map(j => [j.state, j.bytes]), [['queued',12], ['queued',4], ['queued',8], ['recognized',4]]);
  assert.equal(store.getSession(child.stdout).lastSeenAt, 150); assert.equal(store.listJobs(child.stdout)[3].text, 'durable output');
  assert.equal(store.status().spoolBytes, 24);
});

test('startup preserves validated flock inode and removes only exact validated conversion crash namespace', t => {
  const { root } = fixture(t); const lock = path.join(root, '.writer.lock'); fs.writeFileSync(lock, '', { mode: 0o600 });
  const inode = fs.statSync(lock).ino; const dir = fs.mkdtempSync(path.join(root, '.recognize-')); fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'audio.16k.wav'), Buffer.alloc(32), { mode: 0o600 });
  new Store({ root }).recover(); assert.equal(fs.existsSync(dir), false); assert.equal(fs.statSync(lock).ino, inode);
  const bad = fs.mkdtempSync(path.join(root, '.recognize-')); fs.chmodSync(bad, 0o700);
  fs.writeFileSync(path.join(bad, 'unexpected-secret'), 'do not delete', { mode: 0o600 });
  assert.throws(() => new Store({ root }), /CONVERSION_DIR_INVALID/); assert.equal(fs.existsSync(path.join(bad, 'unexpected-secret')), true);
});

test('startup refuses conversion/lock symlinks and linked or loose metadata rather than following them', t => {
  const f = fixture(t); const dir = fs.mkdtempSync(path.join(f.root, '.recognize-')); fs.chmodSync(dir, 0o700);
  fs.symlinkSync(f.store.file('p', f.j.id), path.join(dir, 'audio.16k.wav'));
  assert.throws(() => new Store({ root: f.root })); fs.unlinkSync(path.join(dir, 'audio.16k.wav')); fs.rmdirSync(dir);
  fs.symlinkSync(f.store.file('p', f.j.id), path.join(f.root, '.writer.lock')); assert.throws(() => new Store({ root: f.root }));
  fs.unlinkSync(path.join(f.root, '.writer.lock')); fs.chmodSync(f.store.file('j', f.j.id), 0o644);
  assert.throws(() => new Store({ root: f.root }), /PRIVATE_FILE_REQUIRED/);
});

test('failed append AND failed rollback quarantine new writes and count uncertain physical spool until terminal cleanup', t => {
  const { store, j } = fixture(t); store.appendPcm(j.id, Buffer.alloc(4));
  const sync = fs.fsyncSync, truncate = fs.ftruncateSync; let rejectSync = true;
  fs.fsyncSync = function(fd) { if (rejectSync && fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size === 8) {
    rejectSync = false; throw Error('fsync failed'); } return sync.call(fs, fd); };
  fs.ftruncateSync = () => { throw Error('rollback failed'); };
  try { assert.throws(() => store.appendPcm(j.id, Buffer.alloc(4)), /PCM_WRITE_FAILED/); }
  finally { fs.fsyncSync = sync; fs.ftruncateSync = truncate; }
  assert.equal(store.getJob(j.id).bytes, 4); assert.equal(store.status().spoolBytes, 8); assert.equal(store.status().storageFault, true);
  assert.throws(() => store.appendPcm(j.id, Buffer.alloc(4)), /STORAGE_QUARANTINED/);
  store.queueJob(j.id); assert.throws(() => store.jobForRecognition(j.id), /PCM_SIZE_CHANGED/);
  store.terminal(j.id, 'failed', { issue: 'PCM_WRITE_FAILED' }); assert.equal(store.status().spoolBytes, 0);
});

test('JSON file and parent directory are fsynced; rename failure preserves previous record and removes temporary output', t => {
  const { store, s, root } = fixture(t); const sync = fs.fsyncSync; let fileSync = 0, dirSync = 0;
  fs.fsyncSync = function(fd) { const stat = fs.fstatSync(fd); if (stat.isDirectory()) dirSync++; else fileSync++; return sync.call(fs, fd); };
  try { store.patchSession(s.id, { lastSeenAt: 2 }); } finally { fs.fsyncSync = sync; }
  assert.equal(fileSync, 1); assert.equal(dirSync, 1);
  const rename = fs.renameSync; fs.renameSync = () => { throw Error('rename failed'); };
  try { assert.throws(() => store.patchSession(s.id, { lastSeenAt: 3 })); } finally { fs.renameSync = rename; }
  assert.equal(store.getSession(s.id).lastSeenAt, 2); assert.equal(new Store({ root }).getSession(s.id).lastSeenAt, 2);
  assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.tmp-')));
});


test('private control is one boolean, atomically fsynced and retained without speech/account records', t => {
  const { root, store } = fixture(t); const file = path.join(root, '.control.json');
  const sync = fs.fsyncSync; let fileSync = 0, dirSync = 0;
  fs.fsyncSync = function(fd) { if (fs.fstatSync(fd).isDirectory()) dirSync++; else fileSync++; return sync.call(fs, fd); };
  try { store.setHoldUntilEmpty(true); } finally { fs.fsyncSync = sync; }
  assert.equal(fileSync, 1); assert.equal(dirSync, 1); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { holdUntilEmpty: true });
  const rename = fs.renameSync; fs.renameSync = () => { throw Error('simulated rename failure'); };
  try { assert.throws(() => store.setHoldUntilEmpty(false)); } finally { fs.renameSync = rename; }
  assert.equal(store.getControl().holdUntilEmpty, true); assert.equal(new Store({ root }).getControl().holdUntilEmpty, true);
  assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.tmp-')));
  assert.throws(() => store.setHoldUntilEmpty('false'), /CONTROL_CORRUPT/);
});

test('startup validates control structure, mode, links and size without following unsafe files', t => {
  const { root, store, j } = fixture(t); const file = path.join(root, '.control.json');
  for (const data of ['null', '{}', '{"holdUntilEmpty":1}', '{"holdUntilEmpty":true,"userId":"' + U + '"}']) {
    fs.writeFileSync(file, data, { mode: 0o600 }); assert.throws(() => new Store({ root }), /CONTROL_CORRUPT/);
  }
  fs.writeFileSync(file, '{"holdUntilEmpty":true}'); fs.chmodSync(file, 0o644);
  assert.throws(() => new Store({ root }), /PRIVATE_FILE_REQUIRED/); fs.unlinkSync(file);
  fs.symlinkSync(store.file('p', j.id), file); assert.throws(() => new Store({ root })); fs.unlinkSync(file);
  fs.linkSync(store.file('p', j.id), file); assert.throws(() => new Store({ root }), /PRIVATE_FILE_REQUIRED/); fs.unlinkSync(file);
  fs.writeFileSync(file, ' '.repeat(store.limits.maxJsonBytes + 1), { mode: 0o600 });
  assert.throws(() => new Store({ root }), /METADATA_CORRUPT/);
});

test('expiry is recovery-only: normal pruning leaves live PCM, fresh abandoned work remains recoverable', t => {
  const { root, store, s, j } = fixture(t); store.appendPcm(j.id, Buffer.alloc(4, 1));
  store.prune(1000000000); assert.ok(store.getSession(s.id)); assert.equal(fs.existsSync(store.file('p', j.id)), true);
  const recent = store.createSession({ startedAt: 999999990, participants: s.participants });
  const fresh = store.createJob({ sessionId: recent.id, userId: U, startMs: 0 }); store.appendPcm(fresh.id, Buffer.alloc(4, 1));
  store.patchSession(s.id, { holdUntilEmpty: true });
  const recovered = new Store({ root }); recovered.recover({ now: 1000000000 });
  assert.equal(recovered.getSession(s.id), null); assert.equal(recovered.getJob(j.id), null);
  assert.equal(fs.existsSync(store.file('p', j.id)), false); assert.equal(fs.existsSync(store.file('j', j.id)), false);
  assert.equal(recovered.getJob(fresh.id).state, 'queued'); assert.equal(recovered.status().spoolBytes, 4);
  assert.equal(recovered.getControl().holdUntilEmpty, true);
});

test('interrupted expiry deletion is restart-idempotent and never leaves orphan dependencies', t => {
  for (const failure of ['pcm', 'job', 'session']) {
    const { root, store, s, j } = fixture(t); store.appendPcm(j.id, Buffer.alloc(4, 1));
    const unlink = fs.unlinkSync; const target = store.file(failure === 'pcm' ? 'p' : failure === 'job' ? 'j' : 's', failure === 'session' ? s.id : j.id);
    fs.unlinkSync = function(file) { if (file === target) throw Error('interrupted deletion'); return unlink.call(fs, file); };
    try { assert.throws(() => store.recover({ now: 1000000000 }), /interrupted deletion/); }
    finally { fs.unlinkSync = unlink; }
    const next = new Store({ root }); next.recover({ now: 1000000000 });
    assert.equal(next.listSessions().length, 0); assert.equal(next.listJobs().length, 0);
    assert.equal(next.status().spoolBytes, 0); assert.deepEqual(fs.readdirSync(root), []);
  }
});
